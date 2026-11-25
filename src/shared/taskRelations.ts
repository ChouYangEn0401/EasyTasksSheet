/** 任務關聯與複製任務（feat/task-relations；後端 server/app/features/task_relations.py） */

export const TASK_RELATION_TYPES = ['related'] as const;
export type TaskRelationType = (typeof TASK_RELATION_TYPES)[number];

/** GET /api/tasks/:id/relations 的一筆：對方任務的精簡資訊 */
export type TaskRelation = {
  /** 關聯 id */
  id: number;
  type: TaskRelationType;
  createdBy: number | null;
  createdAt: number;
  task: {
    id: number;
    title: string;
    statusId: number;
    assigneeId: number | null;
    projectId: number;
    dueDate: string | null;
    /** 對方任務已軟刪除（顯示為灰字「已刪除」，不可開啟） */
    deleted: boolean;
  };
};

export type TaskRelationCreateInput = { targetId: number; type?: TaskRelationType };

/** 複製任務時要帶過去的內容（未送的項目預設 true） */
export type TaskDuplicateCopy = {
  description?: boolean;
  customFields?: boolean;
  dates?: boolean;
  assignee?: boolean;
  estimate?: boolean;
  priority?: boolean;
};

/** POST /api/tasks/:id/duplicate */
export type TaskDuplicateInput = {
  title?: string;
  copy?: TaskDuplicateCopy;
  statusId?: number;
  /** 新任務與原任務建立 related（預設 true） */
  relate?: boolean;
};
