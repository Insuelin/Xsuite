// 前后端与插件共享的领域模型。零运行时依赖，只放类型。
// 注意：不要让这里 import 任何 Node 或 DOM 专有模块。

export type RelationKind = 'following' | 'follower' | 'muted' | 'blocked';

export type ActionKind =
  | 'unfollow'
  | 'follow'
  | 'mute'
  | 'unmute'
  | 'block'
  | 'unblock'
  | 'delete_tweet'
  | 'unlike';

export type ActionStatus = 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'skipped';

export type ChangeKind =
  | 'appeared'
  | 'disappeared'
  | 'self_action'
  | 'account_abnormal';

export type UserStatus = 'active' | 'suspended' | 'deactivated' | 'not_found';

export interface User {
  id: string;              // X 数字 user_id (rest_id)，终身不变
  handle: string;          // 不带 @
  prevHandles: string[];
  name: string | null;
  bio: string | null;
  location: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  mediaCount: number | null;
  joinedAt: string | null;
  verified: boolean;
  hasAvatar: boolean;
  protected: boolean;      // 锁推号，取关不可逆
  status: UserStatus;
  lastTweetAt: string | null;
  fetchedAt: string;
}

export interface Relationship {
  accountId: string;
  userId: string;
  kind: RelationKind;
  active: boolean;
  since: string;
  lastSeenAt: string;
  endedAt: string | null;
}

export interface Snapshot {
  id: number;
  accountId: string;
  kind: RelationKind;
  takenAt: string;
  itemCount: number;
  expectedMin: number | null;
  bottomCursor: string | null;
  complete: boolean;
}

export interface SnapshotMember {
  snapshotId: number;
  userId: string;
  position: number;
}

export interface Change {
  id: number;
  accountId: string;
  kind: RelationKind;
  userId: string;
  change: ChangeKind;
  actionId: number | null;
  detectedAt: string;
  fromSnapshot: number;
  toSnapshot: number;
}

export interface Action {
  id: number;
  accountId: string;
  kind: ActionKind;
  targetId: string;
  status: ActionStatus;
  source: string | null;
  reason: string | null;
  batchId: string | null;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  error: string | null;
}

export interface Tweet {
  rowidId: number;
  id: string;
  authorId: string;
  authorHandle: string | null;
  text: string;
  lang: string | null;
  createdAt: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  isReply: boolean;
  isRetweet: boolean;
  hasMedia: boolean;
  raw: string | null;
  fetchedAt: string;
}

export interface WatchTerm {
  id: number;
  term: string;
  kind: 'keyword' | 'hashtag' | 'phrase' | 'from_user';
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  sinceId: string | null;
}

export interface AnalysisResult {
  is_bot: boolean;
  account_type: 'person' | 'org' | 'media' | 'spam' | 'unknown';
  topics: string[];
  value_score: number;
  summary: string;
}

// ---- 实时事件（SSE 推送） ----

export type ServerEvent =
  | { type: 'scrape:progress'; kind: RelationKind; page: number; items: number }
  | { type: 'scrape:done'; kind: RelationKind; snapshotId: number; items: number; complete: boolean }
  | { type: 'action:executed'; actionId: number; kind: ActionKind; targetId: string; ok: boolean; error?: string }
  | { type: 'queue:progress'; pending: number; approved: number; done: number; failed: number }
  | { type: 'cdp:circuit_break'; reason: string }
  | { type: 'cdp:state'; state: 'idle' | 'scraping' | 'acting' | 'paused' };
