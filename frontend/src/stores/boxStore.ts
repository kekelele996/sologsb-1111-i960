import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { CoreBox } from '../types/core-box';
import type { HandoverBatch, HandoverItem } from '../types/handover';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  /** 库架位可留空（缺架位时提示补齐） */
  shelfPos: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

interface BoxState {
  boxes: CoreBox[];
  /** 最近一次未撤回的移交单导入批次（用于整批撤回） */
  lastBatch?: HandoverBatch;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<CoreBox>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  /** 标记/取消破损格 */
  toggleDamagedSlot: (id: string, slot: number) => Promise<void>;
  /** 整批导入移交单（仅写入对账通过的条目，批次留快照可撤回） */
  applyHandover: (rawText: string, items: HandoverItem[]) => Promise<HandoverBatch>;
  /** 整批撤回最近一次导入：按快照还原箱记录 */
  revertLastHandover: () => Promise<HandoverBatch | undefined>;
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  lastBatch: undefined,
  hydrated: false,

  hydrate: async () => {
    const [boxes, batches] = await Promise.all([db.boxes.orderBy('boxNo').toArray(), db.transfers.toArray()]);
    const lastBatch = batches.filter((b) => !b.reverted).sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
    set({ boxes, hydrated: true, lastBatch });
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
      shelfPos: input.shelfPos?.trim() ?? '',
      rackStatus: 'unracked',
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

  applyHandover: async (rawText, items) => {
    const updates = items.filter((item) => item.kind === 'update' && item.localBox && item.rackedAt);
    if (updates.length === 0) {
      throw new Error('没有可写入的条目：全部为差异项，已照本台保留');
    }
    const snapshotIds = new Set(updates.map((item) => item.localBox?.id).filter((v): v is string => Boolean(v)));
    const currentBoxes = get().boxes.filter((box) => snapshotIds.has(box.id));

    const batch: HandoverBatch = {
      id: uid('transfer'),
      importedAt: new Date().toISOString(),
      rawText,
      appliedBoxNos: updates.map((item) => item.boxNo),
      snapshots: currentBoxes,
      items,
      updateCount: updates.length,
      issueCount: items.length - updates.length,
      reverted: false,
    };

    const nextBoxes = [...get().boxes];
    await db.transaction('rw', db.boxes, db.transfers, async () => {
      updates.forEach((item) => {
        const index = nextBoxes.findIndex((box) => box.id === item.localBox?.id);
        if (index < 0) return;
        const next: CoreBox = {
          ...nextBoxes[index],
          shelfPos: item.shelfPos.trim(),
          rackedAt: item.rackedAt,
          rackStatus: 'racked',
        };
        nextBoxes[index] = next;
        db.boxes.put(next);
      });
      await db.transfers.put(batch);
    });
    nextBoxes.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    set({ boxes: nextBoxes, lastBatch: batch });
    return batch;
  },

  revertLastHandover: async () => {
    const batch = get().lastBatch;
    if (!batch || batch.reverted) return undefined;

    const nextBoxes = [...get().boxes];
    await db.transaction('rw', db.boxes, db.transfers, async () => {
      batch.snapshots.forEach((snapshot) => {
        const index = nextBoxes.findIndex((box) => box.id === snapshot.id);
        // 整箱还原快照（含 rackedAt 缺省、架位预排值），导入后的改动一并回退
        if (index >= 0) nextBoxes[index] = { ...snapshot };
        db.boxes.put({ ...snapshot });
      });
      await db.transfers.put({ ...batch, reverted: true });
    });
    nextBoxes.sort((a, b) => a.boxNo.localeCompare(b.boxNo));
    set({ boxes: nextBoxes, lastBatch: undefined });
    return batch;
  },
}));
