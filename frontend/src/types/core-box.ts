/** 岩芯箱入架状态 */
export type ShelfStatus = 'shelved' | 'unshelved';

export const SHELF_STATUS_TEXT: Record<ShelfStatus, string> = {
  shelved: '已入架',
  unshelved: '未入架',
};

/** 岩芯箱 */
export interface CoreBox {
  id: string;
  /** 箱号 */
  boxNo: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起始深度（m） */
  fromDepth: number;
  /** 终止深度（m） */
  toDepth: number;
  /** 格数 */
  slots: number;
  /** 每格长度（m） */
  slotLength: number;
  /** 装箱日期 ISO */
  boxedAt: string;
  /** 库架位（计划/分配的货架位） */
  shelfPos: string;
  /** 入架状态：已入架 / 未入架 */
  shelfStatus: ShelfStatus;
  /** 入架时间 ISO（实际放上货架的时间） */
  shelvedAt?: string;
  /** 破损格（格序号，从 1 开始） */
  damagedSlots: number[];
  /** 装箱人 */
  operator: string;
  /** 备注 */
  remark?: string;
}

/** 库管员移交单中的一条箱位移交记录 */
export interface HandoverItem {
  /** 箱号 */
  boxNo: string;
  /** 货架位 */
  shelfPos: string;
  /** 入架时间（ISO 或日期字符串） */
  shelvedAt: string;
}

/** 库管员发来的箱位移交单 */
export interface HandoverForm {
  /** 移交单号（可选） */
  handoverNo?: string;
  /** 移交方（可选） */
  from?: string;
  /** 接收方（可选） */
  to?: string;
  /** 移交箱位明细 */
  items: HandoverItem[];
}

/** 核对差异类型：箱子对不上 / 货架位重复 / 入架时间空着 / 货架位与本台他箱冲突 / 移交单箱号重复 */
export type ReconcileIssueType = 'unmatched' | 'duplicateShelf' | 'emptyTime' | 'conflictShelf' | 'duplicateBoxNo';

export const RECONCILE_ISSUE_TEXT: Record<ReconcileIssueType, string> = {
  unmatched: '箱子对不上',
  duplicateShelf: '货架位重复',
  emptyTime: '入架时间空着',
  conflictShelf: '货架位冲突',
  duplicateBoxNo: '移交单箱号重复',
};

/** 一条核对差异（本台数据保留，不应用移交单） */
export interface ReconcileIssue {
  type: ReconcileIssueType;
  /** 移交单中的箱号 */
  boxNo: string;
  /** 移交单中的货架位 */
  shelfPos?: string;
  /** 移交单中的入架时间 */
  shelvedAt?: string;
  /** 涉及的本台箱号（冲突时） */
  localBoxNo?: string;
  /** 差异说明 */
  message: string;
}

/** 一条可应用的更新（按箱号匹配且无问题） */
export interface ReconcileUpdate {
  box: CoreBox;
  shelfPos: string;
  shelvedAt: string;
  /** 货架位是否与本台不同 */
  shelfPosChanged: boolean;
  /** 入架时间是否与本台不同 */
  shelvedAtChanged: boolean;
}

/** 移交单核对结果 */
export interface ReconcileResult {
  /** 可应用的更新 */
  updates: ReconcileUpdate[];
  /** 有差异、保留本台的项 */
  issues: ReconcileIssue[];
  /** 移交单总条数 */
  total: number;
}

/** 岩芯箱与回次的连续性校验结果 */
export interface BoxContinuity {
  box: CoreBox;
  /** 区间是否被回次完整覆盖 */
  covered: boolean;
  /** 断档区间（未被回次覆盖的深度段） */
  gaps: Array<{ from: number; to: number }>;
  /** 提示文案 */
  message: string;
}

export const SHELF_POSITIONS: string[] = ['A 区 1 架', 'A 区 2 架', 'B 区 1 架', 'B 区 2 架', 'C 区 1 架'];
