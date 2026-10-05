import type { CoreBox } from './core-box';

/** 库管员移交单解析出的一行 */
export interface HandoverRow {
  /** 移交单内物理行号（从 1 开始，含表头） */
  lineNo: number;
  /** 箱号（trim 后，未取到则为空） */
  boxNo: string;
  /** 货架位（trim 后，未取到则为空） */
  shelfPos: string;
  /** 入架时间原始文本 */
  rackedAtText: string;
}

/** 一行移交单的对账处置结论 */
export type HandoverIssueKind =
  | 'consistent' // 与本台完全一致（已入架、架位/时间相同）
  | 'update' // 可更新：按移交单写入货架位与入架时间
  | 'boxMissing' // 箱号本台查无，照本台保留
  | 'shelfDuplicate' // 货架位与其他箱子（或批内多行）重复，照本台保留
  | 'rackedAtEmpty' // 入架时间空/无法识别，照本台保留
  | 'duplicateBoxNo' // 同一箱号在移交单内重复出现，照本台保留
  | 'malformed'; // 行内容残缺无法识别，照本台保留

export interface HandoverItem extends HandoverRow {
  kind: HandoverIssueKind;
  /** 匹配到的本台岩芯箱 */
  localBox?: CoreBox;
  /** 解析后的入架时间 ISO */
  rackedAt?: string;
  /** 差异/处置说明 */
  detail: string;
}

/** 一次移交单对账的完整结果 */
export interface HandoverReconcile {
  items: HandoverItem[];
  /** 可以正常写入（已入架）的条目 */
  updates: HandoverItem[];
  /** 移交单未提及、保持本台原样的箱数 */
  untouchedCount: number;
}

/** 一次移交单导入批次（用于整体撤回） */
export interface HandoverBatch {
  id: string;
  /** 导入时间 ISO */
  importedAt: string;
  rawText: string;
  /** 本批实际写入的箱号 */
  appliedBoxNos: string[];
  /** 写入前这些箱的完整快照（撤回时整箱还原） */
  snapshots: CoreBox[];
  /** 导入时的差异条目（与 items 同构，存 JSON） */
  items: HandoverItem[];
  updateCount: number;
  issueCount: number;
  /** 是否已撤回 */
  reverted: boolean;
}
