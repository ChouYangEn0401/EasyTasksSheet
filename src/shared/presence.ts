/** 在線感知（/api/presence 與 SSE `presence` 事件；server/app/features/presence.py） */

export type PresenceStatus = 'online' | 'idle' | 'offline';
export type PresenceMode = 'viewing' | 'editing';

export type PresenceEntity = {
  type: 'task';
  id: number;
  /** 伺服器查詢的標題摘要（最多 60 字） */
  title: string;
  mode: PresenceMode;
};

export type PresenceMember = {
  userId: number;
  status: PresenceStatus;
  /** 目前頁面（如「甘特圖」）；離線或隱藏動態時為 null */
  view: string | null;
  entity: PresenceEntity | null;
  /** 最後一次回報（ms）；從未上線為 null */
  lastSeenAt: number | null;
  lastView: string | null;
};

export type PresenceResponse = {
  members: PresenceMember[];
  onlineMs: number;
  idleMs: number;
  keepaliveMs: number;
};

/** PUT /api/presence 的 body */
export type PresenceReport = {
  view: string | null;
  entity: { type: 'task'; id: number; mode: PresenceMode } | null;
  state: 'active' | 'idle' | 'away';
  hidden: boolean;
};
