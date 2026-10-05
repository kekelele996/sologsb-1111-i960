import { create } from 'zustand';
import { db, getMeta, setMeta } from '../utils/db';
import { uid } from '../utils/id';
import { reconcileHandover } from '../utils/handover';
import type { CoreBox, HandoverForm, ReconcileResult, ShelfStatus } from '../types/core-box';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  shelfPos: string;
  shelfStatus?: ShelfStatus;
  shelvedAt?: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

/** 一次移交单导入的摘要（用于界面展示与撤回） */
export interface HandoverImportSummary {
  /** 导入时间 ISO */
  time: string;
  /** 移交单号 */
  handoverNo?: string;
  /** 可应用条数 */
  applied: number;
  /** 差异条数 */
  issues: number;
}

interface BoxState {
  boxes: CoreBox[];
  hydrated: boolean;
  /** 是否存在可撤回的导入快照 */
  canRollback: boolean;
  /** 最近一次导入摘要 */
  lastImportSummary: HandoverImportSummary | null;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<BoxInput>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  /** 标记/取消破损格 */
  toggleDamagedSlot: (id: string, slot: number) => Promise<void>;
  /** 导入库管员移交单：按箱号核对，差异保留本台，可整体撤回 */
  importHandover: (form: HandoverForm) => Promise<{ result: ReconcileResult; summary: HandoverImportSummary }>;
  /** 撤回最近一次导入（恢复导入前快照） */
  rollbackHandover: () => Promise<boolean>;
  /** 放弃撤回（清除快照） */
  dismissRollback: () => Promise<void>;
  /** 手动标记入架 */
  markShelved: (id: string, shelvedAt: string) => Promise<void>;
  /** 手动标记未入架 */
  markUnshelved: (id: string) => Promise<void>;
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  hydrated: false,
  canRollback: false,
  lastImportSummary: null,

  hydrate: async () => {
    const [boxes, snapshot, summaryStr] = await Promise.all([
      db.boxes.orderBy('boxNo').toArray(),
      getMeta(META_SNAPSHOT),
      getMeta(META_SUMMARY),
    ]);
    const lastImportSummary = summaryStr ? (JSON.parse(summaryStr) as HandoverImportSummary) : null;
    set({ boxes, hydrated: true, canRollback: Boolean(snapshot), lastImportSummary });
  },

  addBox: async (input) => {
    const box: CoreBox = {
      id: uid('box'),
      boxNo: input.boxNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      slots: Number(input.slots) || 0,
      slotLength: Number(input.slotLength) || 0,
      boxedAt: input.boxedAt,
      shelfPos: input.shelfPos,
      shelfStatus: input.shelfStatus ?? 'unshelved',
      shelvedAt: input.shelvedAt,
      damagedSlots: input.damagedSlots ?? [],
      operator: input.operator.trim(),
      remark: input.remark?.trim() || undefined,
    };
    await db.boxes.put(box);
    set({ boxes: [...get().boxes, box] });
    return box;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = { ...current, ...patch };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  removeBox: async (id) => {
    await db.boxes.delete(id);
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },

  toggleDamagedSlot: async (id, slot) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const damagedSlots = current.damagedSlots.includes(slot)
      ? current.damagedSlots.filter((s) => s !== slot)
      : [...current.damagedSlots, slot].sort((a, b) => a - b);
    const next: CoreBox = { ...current, damagedSlots };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  importHandover: async (form) => {
    const boxes = get().boxes;
    const result = reconcileHandover(form, boxes);
    if (result.updates.length === 0) {
      return { result, summary: { time: new Date().toISOString(), handoverNo: form.handoverNo, applied: 0, issues: result.issues.length } };
    }

    // 保存导入前快照（用于整体撤回）
    const snapshot = boxes.map((b) => ({ ...b }));
    const now = new Date().toISOString();
    const summary: HandoverImportSummary = {
      time: now,
      handoverNo: form.handoverNo,
      applied: result.updates.length,
      issues: result.issues.length,
    };

    // 应用更新：货架位、入架时间、入架状态
    const updatedBoxes = boxes.map((b) => {
      const upd = result.updates.find((u) => u.box.id === b.id);
      if (!upd) return b;
      return { ...b, shelfPos: upd.shelfPos, shelvedAt: upd.shelvedAt, shelfStatus: 'shelved' as ShelfStatus };
    });

    await db.transaction('rw', db.boxes, db.meta, async () => {
      await db.boxes.bulkPut(updatedBoxes);
      await setMeta(META_SNAPSHOT, JSON.stringify(snapshot));
      await setMeta(META_SUMMARY, JSON.stringify(summary));
    });

    set({ boxes: updatedBoxes, canRollback: true, lastImportSummary: summary });
    return { result, summary };
  },

  rollbackHandover: async () => {
    const snapshotStr = await getMeta(META_SNAPSHOT);
    if (!snapshotStr) return false;
    const snapshot = JSON.parse(snapshotStr) as CoreBox[];
    await db.transaction('rw', db.boxes, db.meta, async () => {
      await db.boxes.clear();
      await db.boxes.bulkPut(snapshot);
      await db.meta.delete(META_SNAPSHOT);
      await db.meta.delete(META_SUMMARY);
    });
    set({ boxes: snapshot, canRollback: false, lastImportSummary: null });
    return true;
  },

  dismissRollback: async () => {
    await db.transaction('rw', db.meta, async () => {
      await db.meta.delete(META_SNAPSHOT);
      await db.meta.delete(META_SUMMARY);
    });
    set({ canRollback: false, lastImportSummary: null });
  },

  markShelved: async (id, shelvedAt) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = { ...current, shelfStatus: 'shelved', shelvedAt };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  markUnshelved: async (id) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = { ...current, shelfStatus: 'unshelved', shelvedAt: undefined };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },
}));

const META_SNAPSHOT = 'handover-import-snapshot';
const META_SUMMARY = 'handover-import-summary';
