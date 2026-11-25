// 任務依賴（阻擋關係）與延遲鏈（feat/delay-link，docs/design/delay-link.md）。
// 後端：server/app/features/dependencies.py、server/app/dependency_calc.py。

export type DependencyDirection = 'blocked_by' | 'blocks';

/** GET /api/tasks 每筆任務額外附帶的依賴欄位（單次批次推算） */
export type TaskDependencyFields = {
  /** 有未完成的前置任務 */
  isBlocked: boolean;
  /** 未完成的前置任務數 */
  blockedByCount: number;
  /** 正在等待本任務的未完成任務數 */
  blocksCount: number;
  /** 預計完成 − 原到期日（≥0）；無到期日或無法推算為 null */
  delayDays: number | null;
  /** 預計完成日（YYYY-MM-DD）；不在任何依賴中或無法推算為 null */
  projectedEnd: string | null;
};

export type DependencyProjection = TaskDependencyFields & {
  projectedStart: string | null;
  /** 有前置任務沒有任何日期（對方尚未排程），無法推算延後 */
  unknownBlockerDate: boolean;
};

export type DependencyTaskBrief = {
  id: number;
  title: string;
  statusId: number;
  assigneeId: number | null;
  projectId: number;
  startDate: string | null;
  dueDate: string | null;
  isDone: boolean;
};

export type DependencyItem = {
  /** 依賴關係 id */
  id: number;
  blockerId: number;
  blockedId: number;
  type: 'finish_to_start';
  /** 前置任務完成後至少再等幾天 */
  lagDays: number;
  note: string;
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
  /** 對方任務 */
  task: DependencyTaskBrief;
  /** 對方任務目前的延後資訊 */
  projection: DependencyProjection;
};

export type TaskDependencies = {
  /** 等待這些任務完成（前置任務） */
  blockedBy: DependencyItem[];
  /** 完成後可開始的任務 */
  blocks: DependencyItem[];
  self: DependencyProjection;
};

export type DependencyCreateInput = {
  direction: DependencyDirection;
  targetId: number;
  lagDays?: number;
  note?: string;
};

export type DependencyMutationResult = DependencyItem & {
  direction: DependencyDirection;
  self: DependencyProjection;
};

export type DependencyRemoved = {
  ok: true;
  removed: { direction: DependencyDirection; targetId: number; lagDays: number; note: string };
};

export type DelayChainNode = DependencyTaskBrief & {
  projectedStart: string | null;
  projectedEnd: string | null;
  delayDays: number | null;
  isBlocked: boolean;
  unknownBlockerDate: boolean;
  /** 在鏈中的層數（沒有前置者為 0） */
  depth: number;
  blockerIds: number[];
  /** 是否在最長延遲路徑上 */
  criticalDelay: boolean;
};

export type DelayChainEdge = {
  id: number;
  from: number;
  to: number;
  lagDays: number;
  note: string;
  /** 兩端皆未完成（仍在擋） */
  active: boolean;
  /** 在最長延遲路徑上 */
  critical: boolean;
};

export type DelayChain = {
  id: number;
  nodes: DelayChainNode[];
  edges: DelayChainEdge[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    maxDelayDays: number;
    finalProjectedEnd: string | null;
    criticalPath: number[];
    /** 目前可立即開始的起點任務 */
    startNodes: number[];
    doneCount: number;
  };
};

export type DelayChainsResponse = { today: string; chains: DelayChain[] };

/** 循環時 409 的 error.details */
export type DependencyCycleDetails = { cycle: { id: number; title: string }[] };
