import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import type { CoreBox } from '../types/core-box';
import type { HandoverItem, HandoverReconcile, HandoverRow } from '../types/handover';

dayjs.extend(customParseFormat);

/** 移交单支持的入架时间格式（库管员台账常见写法） */
const RACKED_AT_FORMATS = [
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DD',
  'YYYY/MM/DD HH:mm:ss',
  'YYYY/MM/DD HH:mm',
  'YYYY/MM/DD',
  'YYYY.MM.DD HH:mm:ss',
  'YYYY.MM.DD HH:mm',
  'YYYY.MM.DD',
  'YYYY年MM月DD日 HH:mm',
  'YYYY年M月D日 HH:mm',
  'YYYY年MM月DD日',
  'YYYY年M月D日',
];

/** 宽松解析入架时间，无法识别返回 undefined */
export function parseRackedAt(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const parsed = dayjs(value, RACKED_AT_FORMATS, true);
  return parsed.isValid() ? parsed.second(0).millisecond(0).toISOString() : undefined;
}

/** 时间按「分钟」精度比较是否一致（台账一般不记秒） */
function sameMinute(isoA?: string, isoB?: string): boolean {
  if (!isoA || !isoB) return isoA === isoB;
  return dayjs(isoA).isSame(dayjs(isoB), 'minute');
}

const HEADER_ALIASES: Record<'boxNo' | 'shelfPos' | 'rackedAt', string[]> = {
  boxNo: ['箱号', '箱编号', '岩芯箱号', 'boxno', 'box'],
  shelfPos: ['货架位', '架位', '库架位', '货架', 'shelf', 'shelfpos', 'position'],
  rackedAt: ['入架时间', '上架时间', '入库时间', '移交时间', '入架日期', 'rackedat', 'time', 'date'],
};

function matchColumn(cell: string, aliases: string[]): boolean {
  const v = cell.trim().toLowerCase();
  if (!v) return false;
  return aliases.some((alias) => (/[a-z]/.test(alias) ? v === alias : cell.trim().includes(alias)));
}

/** 拆分一行为单元格：制表符优先，其次逗号，再次多空格（单空格也兜底） */
function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return line.split(',');
  if (/ {2,}/.test(line)) return line.split(/ {2,}/);
  return line.split(/ +/);
}

/** 去掉 CSV 风格的外层引号 */
function unquote(cell: string): string {
  const v = cell.trim();
  if (v.length >= 2 && /^["'].*["']$/.test(v)) return v.slice(1, -1).trim();
  return v;
}

/** 无表头行里识别时间单元格：日期部分，后面可能隔着空格跟 HH:mm */
const TIME_CELL_PATTERN = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(\s+\d{1,2}:\d{2}(:\d{2})?)?/;

/** 箱号格式：编号型（字母/数字-编号），纯中文句子不算箱号 */
const BOX_NO_PATTERN = /^[A-Za-z0-9][\w\-—]*[-—][\w\-—]+$/;

/** 从无表头的单元格行里，按列位/内容特征取箱号、货架位、时间 */
function positionalRow(cells: string[]): Omit<HandoverRow, 'lineNo'> {
  const rest = [...cells];
  // 时间可能被空格切成「2026年9月20日」「10:00」两个单元格，识别后拼回
  const timeIndex = rest.findIndex((c) => TIME_CELL_PATTERN.test(c));
  let rackedAtText = '';
  if (timeIndex >= 0) {
    const following = rest[timeIndex + 1];
    const suffix = following && /^\d{1,2}:\d{2}(:\d{2})?$/.test(following) ? ` ${following}` : '';
    if (suffix) rest.splice(timeIndex + 1, 1);
    const datePart = rest.splice(timeIndex, 1)[0];
    rackedAtText = (datePart.match(TIME_CELL_PATTERN)?.[0] ?? datePart) + suffix;
  }
  // 箱号特征：含 X- 前缀，或明显是编号（字母数字连字符）且不是纯数字
  const boxIndex = rest.findIndex((c) => /X\s*[-—]\s*\w/i.test(c) || /^[A-Za-z]+[-—]\w+/.test(c));
  const boxNo = boxIndex >= 0 ? rest.splice(boxIndex, 1)[0] : rest.shift() ?? '';
  return { boxNo: boxNo.trim(), shelfPos: rest.join(' ').trim(), rackedAtText: rackedAtText.trim() };
}

/**
 * 解析库管员移交单文本。
 * 支持带表头（按列名识别，列序不限）与无表头（列位：箱号/货架位/入架时间，可含表头外杂列）。
 */
export function parseHandoverText(text: string): HandoverRow[] {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (rawLines.length === 0) {
    throw new Error('移交单内容为空，请粘贴库管员发来的箱号/货架位/入架时间清单');
  }

  const headerCells = splitLine(rawLines[0]).map(unquote);
  const colOf = (aliases: string[]) => headerCells.findIndex((c) => matchColumn(c, aliases));
  const boxCol = colOf(HEADER_ALIASES.boxNo);
  const shelfCol = colOf(HEADER_ALIASES.shelfPos);
  const timeCol = colOf(HEADER_ALIASES.rackedAt);
  const hasHeader = boxCol >= 0;

  const dataLines = hasHeader ? rawLines.slice(1) : rawLines;
  if (hasHeader && dataLines.length === 0) {
    throw new Error('移交单只有表头没有数据行');
  }

  const rows: HandoverRow[] = [];
  dataLines.forEach((line, idx) => {
    const lineNo = (hasHeader ? 2 : 1) + idx;
    const cells = splitLine(line).map(unquote);
    if (hasHeader) {
      rows.push({
        lineNo,
        boxNo: (cells[boxCol] ?? '').trim(),
        shelfPos: shelfCol >= 0 ? (cells[shelfCol] ?? '').trim() : '',
        rackedAtText: timeCol >= 0 ? (cells[timeCol] ?? '').trim() : '',
      });
    } else {
      rows.push({ lineNo, ...positionalRow(cells) });
    }
  });
  return rows;
}

/**
 * 按箱号把移交单与本台岩芯箱核对。
 * 规则（来自现场约定）：
 * - 箱号本台查无、移交单内箱号重复、货架位重复、入架时间空/无法识别：照本台保留，仅列差异；
 * - 架位与入架时间都和本台一致：无需处理；
 * - 其余正常匹配：按移交单写入并标记已入架。
 */
export function reconcileHandover(rows: HandoverRow[], boxes: CoreBox[]): HandoverReconcile {
  const byBoxNo = new Map<string, CoreBox>();
  boxes.forEach((box) => byBoxNo.set(box.boxNo.trim(), box));

  // 移交单内箱号出现次数
  const boxNoCount = new Map<string, number>();
  rows.forEach((row) => {
    const key = row.boxNo;
    if (key) boxNoCount.set(key, (boxNoCount.get(key) ?? 0) + 1);
  });

  // 本台已入架箱占用的货架位（不含本次候选自身）
  const occupiedShelf = (shelfPos: string, selfBoxNo: string): string | undefined => {
    if (!shelfPos) return undefined;
    const occupant = boxes.find(
      (box) => box.rackStatus === 'racked' && box.shelfPos.trim() === shelfPos && box.boxNo.trim() !== selfBoxNo,
    );
    return occupant?.boxNo;
  };

  const prelim = rows.map<HandoverItem>((row) => {
    if (!row.boxNo) {
      return { ...row, kind: 'malformed', detail: '未识别到箱号，已跳过并保留本台' };
    }
    if (!BOX_NO_PATTERN.test(row.boxNo)) {
      return { ...row, kind: 'malformed', detail: `「${row.boxNo}」不像箱号编号，行内容无法识别，保留本台` };
    }
    if ((boxNoCount.get(row.boxNo) ?? 0) > 1) {
      return {
        ...row,
        kind: 'duplicateBoxNo',
        localBox: byBoxNo.get(row.boxNo),
        detail: `移交单内箱号 ${row.boxNo} 出现 ${boxNoCount.get(row.boxNo)} 次，待与库管员核实，保留本台`,
      };
    }
    const localBox = byBoxNo.get(row.boxNo);
    if (!localBox) {
      return { ...row, kind: 'boxMissing', detail: '本台查无此箱，可能是库管员记错箱号，保留本台' };
    }
    if (!row.shelfPos) {
      return { ...row, kind: 'malformed', localBox, detail: '缺少货架位，行内容不完整，保留本台' };
    }
    const rackedAt = parseRackedAt(row.rackedAtText);
    if (!rackedAt) {
      return {
        ...row,
        kind: 'rackedAtEmpty',
        localBox,
        detail: row.rackedAtText ? `入架时间「${row.rackedAtText}」无法识别，保留本台` : '入架时间空着，保留本台',
      };
    }
    return { ...row, kind: 'update', localBox, rackedAt, detail: '' };
  });

  // 批内候选货架位分组：同架位 ≥2 行全部判重
  const candidates = prelim.filter((item) => item.kind === 'update');
  const shelfGroups = new Map<string, HandoverItem[]>();
  candidates.forEach((item) => {
    const group = shelfGroups.get(item.shelfPos) ?? [];
    group.push(item);
    shelfGroups.set(item.shelfPos, group);
  });

  const items: HandoverItem[] = prelim.map((item): HandoverItem => {
    if (item.kind !== 'update') return item;
    const sameShelf = shelfGroups.get(item.shelfPos) ?? [];
    if (sameShelf.length > 1) {
      const others = sameShelf.filter((other) => other.boxNo !== item.boxNo).map((other) => other.boxNo);
      return {
        ...item,
        kind: 'shelfDuplicate',
        detail: `货架位 ${item.shelfPos} 在移交单内同时开给 ${others.join('、')}，架位重复，保留本台`,
      };
    }
    const occupant = occupiedShelf(item.shelfPos, item.boxNo);
    if (occupant) {
      return {
        ...item,
        kind: 'shelfDuplicate',
        detail: `货架位 ${item.shelfPos} 已被本台已入架箱 ${occupant} 占用，架位重复，保留本台`,
      };
    }
    const local = item.localBox as CoreBox;
    if (
      local.rackStatus === 'racked' &&
      local.shelfPos.trim() === item.shelfPos &&
      sameMinute(local.rackedAt, item.rackedAt)
    ) {
      return { ...item, kind: 'consistent', detail: '与本台已入架信息一致，无需更新' };
    }
    const changes: string[] = [];
    if (local.rackStatus !== 'racked') changes.push('状态：未入架→已入架');
    if (local.shelfPos.trim() !== item.shelfPos) changes.push(`架位：${local.shelfPos || '（空）'}→${item.shelfPos}`);
    if (!sameMinute(local.rackedAt, item.rackedAt)) {
      changes.push(`入架时间：${local.rackedAt ? dayjs(local.rackedAt).format('YYYY-MM-DD HH:mm') : '（空）'}→${dayjs(item.rackedAt).format('YYYY-MM-DD HH:mm')}`);
    }
    return { ...item, detail: changes.join('；') };
  });

  const updates = items.filter((item) => item.kind === 'update');
  const appliedBoxNos = new Set(updates.map((item) => item.boxNo));
  const untouchedCount = boxes.filter((box) => !appliedBoxNos.has(box.boxNo.trim())).length;

  // 按物理行号排序展示
  items.sort((a, b) => a.lineNo - b.lineNo);
  return { items, updates, untouchedCount };
}
