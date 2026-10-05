import type { CoreBox, HandoverForm, HandoverItem, ReconcileIssue, ReconcileResult, ReconcileUpdate } from '../types/core-box';

/** 移交单示例（JSON），供界面「填入示例」使用 */
export const HANDOVER_EXAMPLE = `{
  "handoverNo": "JY-2026-10-05",
  "from": "岩芯库",
  "to": "编录台",
  "items": [
    { "boxNo": "X-2402-01", "shelfPos": "A 区 1 架", "shelvedAt": "2026-09-20" },
    { "boxNo": "X-2402-02", "shelfPos": "A 区 2 架", "shelvedAt": "2026-09-20" },
    { "boxNo": "X-2402-03", "shelfPos": "A 区 3 架", "shelvedAt": "2026-09-21" },
    { "boxNo": "X-2403-01", "shelfPos": "B 区 1 架", "shelvedAt": "2026-09-22" },
    { "boxNo": "X-2403-02", "shelfPos": "B 区 2 架", "shelvedAt": "2026-09-22" },
    { "boxNo": "X-2404-01", "shelfPos": "B 区 3 架", "shelvedAt": "2026-09-23" },
    { "boxNo": "X-2401-01", "shelfPos": "C 区 1 架", "shelvedAt": "2026-09-25" },
    { "boxNo": "X-2405-01", "shelfPos": "C 区 2 架", "shelvedAt": "2026-09-26" }
  ]
}`;

/** 把日期/ISO 字符串规范为 ISO；无法解析时返回空串 */
function normalizeDate(value: unknown): string {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  // 纯日期 YYYY-MM-DD 补 T00:00:00
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(dateOnly ? `${text}T00:00:00` : text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function normalizeItem(raw: Record<string, unknown>): HandoverItem {
  // 兼容中文列名
  const boxNo = String(raw.boxNo ?? raw['箱号'] ?? '').trim();
  const shelfPos = String(raw.shelfPos ?? raw['货架位'] ?? raw['库架位'] ?? '').trim();
  const shelvedAt = normalizeDate(raw.shelvedAt ?? raw['入架时间'] ?? raw['上架时间']);
  return { boxNo, shelfPos, shelvedAt };
}

/** 解析 CSV（首行为表头，兼容中文列名） */
function parseCsv(text: string): HandoverItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(/[,，]/).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(/[,，]/).map((c) => c.trim());
    const raw: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      raw[h] = cells[i] ?? '';
    });
    return normalizeItem(raw);
  });
}

/**
 * 解析库管员移交单文本。
 * 支持 JSON（HandoverForm 或 HandoverItem[]）与 CSV（首行表头，兼容中文列名）。
 */
export function parseHandover(text: string): HandoverForm {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('移交单内容为空');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return { items: parsed.map((item) => normalizeItem(item as Record<string, unknown>)) };
    }
    const obj = parsed as Record<string, unknown>;
    const rawItems = (obj.items ?? obj.rows ?? obj.明细 ?? []) as unknown[];
    if (!Array.isArray(rawItems)) {
      throw new Error('JSON 缺少 items 明细数组');
    }
    return {
      handoverNo: obj.handoverNo != null ? String(obj.handoverNo) : obj['移交单号'] != null ? String(obj['移交单号']) : undefined,
      from: obj.from != null ? String(obj.from) : obj['移交方'] != null ? String(obj['移交方']) : undefined,
      to: obj.to != null ? String(obj.to) : obj['接收方'] != null ? String(obj['接收方']) : undefined,
      items: rawItems.map((item) => normalizeItem(item as Record<string, unknown>)),
    };
  }
  // 按 CSV 解析
  const items = parseCsv(trimmed);
  if (items.length === 0) {
    throw new Error('未能解析出明细，请检查格式（JSON 或带表头的 CSV）');
  }
  return { items };
}

/**
 * 按箱号把移交单与本台岩芯箱台账核对：
 * - 箱子对不上（本台无此箱号）、货架位重复（移交单内同架位多箱）、
 *   入架时间空着、货架位与本台他箱冲突、移交单箱号重复 —— 一律保留本台，列入差异。
 * - 其余按箱号匹配且无问题的，可应用货架位与入架时间。
 */
export function reconcileHandover(form: HandoverForm, boxes: CoreBox[]): ReconcileResult {
  const issues: ReconcileIssue[] = [];
  const updates: ReconcileUpdate[] = [];

  // 1. 移交单内箱号重复
  const boxNoCount = new Map<string, number>();
  form.items.forEach((item) => {
    const key = item.boxNo;
    if (key) boxNoCount.set(key, (boxNoCount.get(key) ?? 0) + 1);
  });
  const duplicatedBoxNos = new Set([...boxNoCount.entries()].filter(([, c]) => c > 1).map(([k]) => k));

  // 2. 移交单内货架位重复
  const shelfPosCount = new Map<string, number>();
  form.items.forEach((item) => {
    if (item.shelfPos) shelfPosCount.set(item.shelfPos, (shelfPosCount.get(item.shelfPos) ?? 0) + 1);
  });
  const duplicatedShelfPos = new Set([...shelfPosCount.entries()].filter(([, c]) => c > 1).map(([k]) => k));

  // 3. 逐条核对
  form.items.forEach((item) => {
    const { boxNo, shelfPos, shelvedAt } = item;

    if (!boxNo) {
      issues.push({ type: 'unmatched', boxNo: '', shelfPos, shelvedAt, message: '移交单存在空箱号记录，保留本台数据' });
      return;
    }

    if (duplicatedBoxNos.has(boxNo)) {
      issues.push({ type: 'duplicateBoxNo', boxNo, shelfPos, shelvedAt, message: `移交单中箱号 ${boxNo} 重复出现，保留本台数据` });
      return;
    }

    const box = boxes.find((b) => b.boxNo === boxNo);
    if (!box) {
      issues.push({ type: 'unmatched', boxNo, shelfPos, shelvedAt, message: `箱号 ${boxNo} 在本台岩芯箱台账中不存在（箱子对不上）` });
      return;
    }

    if (!shelvedAt) {
      issues.push({ type: 'emptyTime', boxNo, shelfPos, message: `箱号 ${boxNo} 入架时间为空，保留本台数据` });
      return;
    }

    if (duplicatedShelfPos.has(shelfPos)) {
      issues.push({ type: 'duplicateShelf', boxNo, shelfPos, shelvedAt, message: `箱号 ${boxNo} 货架位「${shelfPos}」在移交单中重复，保留本台数据` });
      return;
    }

    // 货架位与本台其他箱冲突
    const conflict = boxes.find((b) => b.id !== box.id && b.shelfPos === shelfPos);
    if (conflict) {
      issues.push({
        type: 'conflictShelf',
        boxNo,
        shelfPos,
        shelvedAt,
        localBoxNo: conflict.boxNo,
        message: `箱号 ${boxNo} 货架位「${shelfPos}」已被本台 ${conflict.boxNo} 占用，保留本台数据`,
      });
      return;
    }

    updates.push({
      box,
      shelfPos,
      shelvedAt,
      shelfPosChanged: box.shelfPos !== shelfPos,
      shelvedAtChanged: box.shelvedAt !== shelvedAt,
    });
  });

  return { updates, issues, total: form.items.length };
}
