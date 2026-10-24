// 本地 HTTP 接口。只监听 127.0.0.1，不做鉴权。

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppState } from './state.ts';
import { ActionsRepo } from '../core/db/repos/actions.repo.ts';
import {
  checkReadiness,
  describeFilter,
  findUnfollowCandidates,
  type CandidateFilter,
} from '../core/filter/candidates.ts';
import { emit, onEvent } from '../core/events.ts';
import { runScrapeJob } from '../core/jobs/scrape-job.ts';
import { runActionQueue } from '../core/actions/worker.ts';
import { config } from '../core/config.ts';
import type { ActionKind, ActionStatus, RelationKind } from '../shared/domain.ts';

const RELATION_KINDS: RelationKind[] = ['following', 'followers', 'muted', 'blocked'];
const ACTION_STATUSES: ActionStatus[] = ['pending', 'approved', 'running', 'done', 'failed', 'skipped'];

export function createApp(state: AppState) {
  const app = new Hono();
  const db = state.db;

  app.onError((err, c) => c.json({ error: err.message }, 500));

  // ---- 概览 ----

  app.get('/api/overview', (c) => {
    const accountId = state.accountId();
    const repo = new ActionsRepo(db);

    const activeCount = (kind: RelationKind) =>
      (db.prepare('SELECT COUNT(*) AS n FROM relationships WHERE kind = ? AND active = 1').get(kind) as { n: number }).n;

    const latest = (kind: RelationKind) =>
      db.prepare(`
        SELECT id, item_count, complete, taken_at FROM snapshots
        WHERE kind = ? ORDER BY id DESC LIMIT 1
      `).get(kind) ?? null;

    const typeCounts = Object.fromEntries(
      (db.prepare('SELECT status, COUNT(*) AS n FROM actions GROUP BY status').all() as unknown as {
        status: string;
        n: number;
      }[]).map((r) => [r.status, r.n]),
    );

    return c.json({
      account: { handle: state.handle() },
      counts: {
        users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
        following: activeCount('following'),
        followers: activeCount('followers'),
        muted: activeCount('muted'),
        blocked: activeCount('blocked'),
        whitelist: (db.prepare('SELECT COUNT(*) AS n FROM whitelist').get() as { n: number }).n,
      },
      snapshots: Object.fromEntries(RELATION_KINDS.map((k) => [k, latest(k)])),
      queue: repo.stats(),
      typeCounts,
      quota: {
        today: repo.usedToday(accountId, 'unfollow'),
        perDay: config.action.perDay,
        lastHour: repo.usedLastHour(accountId, 'unfollow'),
        perHour: config.action.perHour,
      },
      readiness: checkReadiness(db, accountId),
      job: state.job,
      dryRun: config.dryRun,
    });
  });

  // ---- 名单 ----

  app.get('/api/users', (c) => {
    const accountId = state.accountId();
    const kind = (c.req.query('kind') ?? 'following') as RelationKind;
    if (!RELATION_KINDS.includes(kind)) return c.json({ error: `未知类型: ${kind}` }, 400);

    const q = (c.req.query('q') ?? '').trim();
    const onlyNoFollowBack = c.req.query('filter') === 'no-follow-back';
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const like = `%${q}%`;

    const rows = db.prepare(`
      SELECT u.id, u.handle, u.name, u.followers, u.following, u.tweets,
             u.has_avatar, u.protected, u.blue_verified, u.joined_at,
             r.since, r.active,
             EXISTS(
               SELECT 1 FROM relationships f
               WHERE f.account_id = r.account_id AND f.user_id = u.id
                 AND f.kind = 'followers' AND f.active = 1
             ) AS follows_back,
             EXISTS(
               SELECT 1 FROM whitelist w
               WHERE w.account_id = r.account_id AND w.user_id = u.id
             ) AS whitelisted
      FROM relationships r
      JOIN users u ON u.id = r.user_id
      WHERE r.account_id = ? AND r.kind = ? AND r.active = 1
        AND (? = '' OR u.handle LIKE ? OR u.name LIKE ?)
      ORDER BY r.since ASC, u.handle ASC
      LIMIT ? OFFSET ?
    `).all(accountId, kind, q, like, like, limit, offset) as unknown as {
      id: string;
      handle: string;
      name: string | null;
      followers: number | null;
      following: number | null;
      tweets: number | null;
      has_avatar: number;
      protected: number;
      blue_verified: number;
      joined_at: string | null;
      since: string | null;
      active: number;
      follows_back: number;
      whitelisted: number;
    }[];

    const items = rows
      .map((r) => ({
        userId: r.id,
        handle: r.handle,
        name: r.name,
        followers: r.followers,
        following: r.following,
        tweets: r.tweets,
        hasAvatar: r.has_avatar === 1,
        protected: r.protected === 1,
        blueVerified: r.blue_verified === 1,
        joinedAt: r.joined_at,
        since: r.since,
        followsBack: r.follows_back === 1,
        whitelisted: r.whitelisted === 1,
      }))
      .filter((r) => !onlyNoFollowBack || !r.followsBack);

    return c.json({ kind, limit, offset, items });
  });

  // ---- 变化 ----

  app.get('/api/changes', (c) => {
    const accountId = state.accountId();
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const rows = db.prepare(`
      SELECT c.id, c.kind, c.user_id, c.change, c.action_id, c.detected_at,
             u.handle, u.name
      FROM changes c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.account_id = ?
      ORDER BY c.id DESC
      LIMIT ?
    `).all(accountId, limit) as unknown as {
      id: number;
      kind: string;
      user_id: string;
      change: string;
      action_id: number | null;
      detected_at: string;
      handle: string | null;
      name: string | null;
    }[];

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        userId: r.user_id,
        handle: r.handle,
        name: r.name,
        change: r.change,
        actionId: r.action_id,
        detectedAt: r.detected_at,
      })),
    });
  });

  // ---- 队列 ----

  app.get('/api/queue', (c) => {
    const repo = new ActionsRepo(db);
    const status = c.req.query('status') as ActionStatus | undefined;
    if (status && !ACTION_STATUSES.includes(status)) {
      return c.json({ error: `未知状态: ${status}` }, 400);
    }
    const rows = repo.list(status, 500);
    const get = db.prepare('SELECT handle, name FROM users WHERE id = ?');
    return c.json({
      items: rows.map((a) => {
        const u = get.get(a.targetId) as { handle: string; name: string | null } | undefined;
        return { ...a, handle: u?.handle ?? null, name: u?.name ?? null };
      }),
    });
  });

  app.post('/api/queue/propose', async (c) => {
    const accountId = state.accountId();
    const body = (await c.req.json().catch(() => ({}))) as { filter?: CandidateFilter };
    const ready = checkReadiness(db, accountId);
    if (!ready.ok) return c.json({ error: ready.problems.join('；') }, 400);

    const filter = body.filter ?? {};
    const candidates = findUnfollowCandidates(db, accountId, filter);
    if (candidates.length === 0) return c.json({ candidates: 0, added: 0 });

    const added = new ActionsRepo(db).propose({
      accountId,
      kind: 'unfollow',
      targetIds: candidates.map((x) => x.userId),
      source: 'filter',
      reason: describeFilter(filter),
      batchId: `filter-${Date.now()}`,
    });
    return c.json({ candidates: candidates.length, added, description: describeFilter(filter) });
  });

  app.post('/api/queue/approve', async (c) => {
    const repo = new ActionsRepo(db);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: number[]; all?: boolean };
    const ids = body.all ? repo.list('pending').map((a) => a.id) : (body.ids ?? []);
    return c.json({ changed: repo.approve(ids) });
  });

  app.post('/api/queue/reject', async (c) => {
    const repo = new ActionsRepo(db);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: number[]; all?: boolean };
    const ids = body.all ? repo.listOpen().map((a) => a.id) : (body.ids ?? []);
    return c.json({ changed: repo.reject(ids) });
  });

  app.post('/api/queue/add', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string; handle?: string; kind?: ActionKind };
    const kind = (body.kind ?? 'unfollow') as ActionKind;

    let userId = body.userId;
    if (!userId && body.handle) {
      const row = db
        .prepare('SELECT id FROM users WHERE handle = ?')
        .get(body.handle.replace(/^@/, '')) as { id: string } | undefined;
      if (!row) return c.json({ error: `users 表里没有 @${body.handle}` }, 404);
      userId = row.id;
    }
    if (!userId) return c.json({ error: '缺少 userId 或 handle' }, 400);

    const added = new ActionsRepo(db).propose({
      accountId: state.accountId(),
      kind,
      targetIds: [userId],
      source: 'manual',
      reason: '手动添加',
    });
    return c.json({ added });
  });

  // ---- 白名单 ----

  app.get('/api/whitelist', (c) => {
    const rows = db.prepare(`
      SELECT w.user_id, w.note, w.created_at, u.handle, u.name
      FROM whitelist w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.account_id = ? ORDER BY w.created_at DESC
    `).all(state.accountId()) as unknown as {
      user_id: string; note: string | null; created_at: string; handle: string | null; name: string | null;
    }[];
    return c.json({
      items: rows.map((r) => ({
        userId: r.user_id, handle: r.handle, name: r.name, note: r.note, createdAt: r.created_at,
      })),
    });
  });

  app.post('/api/whitelist/add', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string; handle?: string; note?: string };
    const accountId = state.accountId();
    let userId = body.userId;
    if (!userId && body.handle) {
      const row = db
        .prepare('SELECT id FROM users WHERE handle = ?')
        .get(body.handle.replace(/^@/, '')) as { id: string } | undefined;
      if (!row) return c.json({ error: `users 表里没有 @${body.handle}` }, 404);
      userId = row.id;
    }
    if (!userId) return c.json({ error: '缺少 userId 或 handle' }, 400);
    db.prepare(`
      INSERT INTO whitelist (account_id, user_id, note, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, user_id) DO UPDATE SET note = excluded.note
    `).run(accountId, userId, body.note ?? null, new Date().toISOString());
    return c.json({ ok: true, userId });
  });

  app.post('/api/whitelist/remove', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
    if (!body.userId) return c.json({ error: '缺少 userId' }, 400);
    db.prepare('DELETE FROM whitelist WHERE account_id = ? AND user_id = ?')
      .run(state.accountId(), body.userId);
    return c.json({ ok: true });
  });

  // ---- 后台任务 ----

  /** 同一时间只允许一个任务；启动后立刻返回，进度走 SSE。 */
  function startJob(kind: 'scrape' | 'actions', label: string, fn: () => Promise<unknown>) {
    if (state.job) {
      throw Object.assign(new Error(`已有任务在跑：${state.job.label}`), { status: 409 });
    }
    state.job = { kind, label, startedAt: new Date().toISOString() };
    emit({ type: 'cdp:state', state: kind === 'scrape' ? 'scraping' : 'acting' });

    void fn()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[job] ${label} 失败: ${msg}`);
        emit({ type: 'cdp:circuit_break', reason: `${label} 失败: ${msg}` });
      })
      .finally(() => {
        state.job = null;
        emit({ type: 'cdp:state', state: 'idle' });
      });
  }

  app.post('/api/jobs/scrape', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: RelationKind };
    const kind = body.kind ?? 'following';
    if (!RELATION_KINDS.includes(kind)) return c.json({ error: `未知类型: ${kind}` }, 400);

    const handle = state.handle();
    try {
      startJob('scrape', `抓取 ${kind}`, async () => {
        const work = await state.getWork();
        const page = await work.ensure();
        await state.mutex.acquire('scraping');
        try {
          return await runScrapeJob({
            db,
            page,
            kind,
            handle,
            log: (m) => console.log(m),
            onEvent: emit,
          });
        } finally {
          state.mutex.release();
        }
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json({ started: true, kind }, 202);
  });

  app.post('/api/jobs/actions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean; limit?: number };
    const dryRun = !body.confirm;

    try {
      startJob('actions', `执行队列${dryRun ? '（演练）' : ''}`, async () => {
        const work = await state.getWork();
        const page = await work.ensure();
        return runActionQueue({
          db,
          accountId: state.accountId(),
          page,
          dryRun,
          mutex: state.mutex,
          maxActions: body.limit,
          log: (m) => console.log(m),
          onEvent: emit,
        });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json({ started: true, dryRun }, 202);
  });

  app.post('/api/jobs/stop', (c) => {
    if (!state.job) return c.json({ stopped: false });
    state.mutex.pause('用户手动停止');
    return c.json({ stopped: true });
  });

  // ---- SSE ----

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const off = onEvent((e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
      });
      const timer = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
      }, 25_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      off();
      clearInterval(timer);
    }),
  );

  return app;
}
