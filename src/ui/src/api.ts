// 后端接口封装。所有路径都走相对路径，开发时由 Vite 代理到 7420。

import type { Action, ActionKind, ActionStatus, RelationKind, ServerEvent } from '../../shared/domain.ts';

export interface SnapshotInfo {
  id: number;
  item_count: number;
  complete: number;
  taken_at: string;
}

export interface Readiness {
  ok: boolean;
  following: { id: number; itemCount: number; takenAt: string } | null;
  followers: { id: number; itemCount: number; takenAt: string } | null;
  problems: string[];
  warnings: string[];
}

export interface Overview {
  account: { handle: string };
  counts: {
    users: number;
    following: number;
    followers: number;
    muted: number;
    blocked: number;
    whitelist: number;
  };
  snapshots: Record<RelationKind, SnapshotInfo | null>;
  queue: {
    pending: number;
    approved: number;
    running: number;
    done: number;
    failed: number;
    skipped: number;
  };
  typeCounts: Record<string, number>;
  quota: { today: number; perDay: number; lastHour: number; perHour: number };
  readiness: Readiness;
  job: { kind: 'scrape' | 'actions'; label: string; startedAt: string } | null;
  dryRun: boolean;
}

export interface UserRow {
  userId: string;
  handle: string;
  name: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  hasAvatar: boolean;
  protected: boolean;
  blueVerified: boolean;
  joinedAt: string | null;
  since: string | null;
  followsBack: boolean;
  whitelisted: boolean;
}

export interface QueueItem extends Action {
  handle: string | null;
  name: string | null;
}

export interface ChangeRow {
  id: number;
  kind: string;
  userId: string;
  handle: string | null;
  name: string | null;
  change: string;
  actionId: number | null;
  detectedAt: string;
}

export interface CandidateFilter {
  requireNoFollowBack?: boolean;
  excludeProtected?: boolean;
  noAvatar?: boolean;
  zeroTweets?: boolean;
  minFollowDays?: number;
  maxFollowers?: number;
  limit?: number;
}

export interface WhitelistItem {
  userId: string;
  handle: string | null;
  name: string | null;
  note: string | null;
  createdAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  overview: () => req<Overview>('/api/overview'),

  users: (params: { kind: RelationKind; q?: string; filter?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams({ kind: params.kind });
    if (params.q) qs.set('q', params.q);
    if (params.filter) qs.set('filter', params.filter);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    return req<{ items: UserRow[] }>(`/api/users?${qs}`);
  },

  changes: (limit = 100) => req<{ items: ChangeRow[] }>(`/api/changes?limit=${limit}`),

  queue: (status?: ActionStatus) =>
    req<{ items: QueueItem[] }>(`/api/queue${status ? `?status=${status}` : ''}`),

  propose: (filter: CandidateFilter) =>
    post<{ candidates: number; added: number; description?: string }>('/api/queue/propose', { filter }),

  approve: (body: { ids?: number[]; all?: boolean }) =>
    post<{ changed: number }>('/api/queue/approve', body),

  reject: (body: { ids?: number[]; all?: boolean }) =>
    post<{ changed: number }>('/api/queue/reject', body),

  add: (body: { userId?: string; handle?: string; kind?: ActionKind }) =>
    post<{ added: number }>('/api/queue/add', body),

  whitelist: () => req<{ items: WhitelistItem[] }>('/api/whitelist'),
  whitelistAdd: (body: { userId?: string; handle?: string; note?: string }) =>
    post<{ ok: boolean }>('/api/whitelist/add', body),
  whitelistRemove: (userId: string) => post<{ ok: boolean }>('/api/whitelist/remove', { userId }),

  startScrape: (kind: RelationKind) => post<{ started: boolean }>('/api/jobs/scrape', { kind }),
  startActions: (body: { confirm?: boolean; limit?: number }) =>
    post<{ started: boolean }>('/api/jobs/actions', body),
  stop: () => post<{ stopped: boolean }>('/api/jobs/stop', {}),
};

const EVENT_TYPES: ServerEvent['type'][] = [
  'scrape:progress',
  'scrape:done',
  'action:executed',
  'queue:progress',
  'cdp:circuit_break',
  'cdp:state',
];

/** 订阅服务端推送。回调每次渲染都会变也没关系，用 ref 兜住。 */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  const es = new EventSource('/api/events');
  const handler = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(ev.data) as ServerEvent);
    } catch {
      /* 心跳等非 JSON 消息忽略 */
    }
  };
  for (const t of EVENT_TYPES) es.addEventListener(t, handler);
  return () => es.close();
}
