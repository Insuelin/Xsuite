// 操作队列与每日配额。

import type { Db } from '../client.ts';
import { nowIso, todayLocal } from '../client.ts';
import type { Action, ActionKind, ActionStatus } from '../../../shared/domain.ts';

interface ActionRow {
  id: number;
  account_id: string;
  kind: string;
  target_id: string;
  status: string;
  source: string | null;
  reason: string | null;
  batch_id: string | null;
  created_at: string;
  approved_at: string | null;
  executed_at: string | null;
  error: string | null;
  dry_run: number;
}

function toDomain(r: ActionRow): Action {
  return {
    id: r.id,
    accountId: r.account_id,
    kind: r.kind as ActionKind,
    targetId: r.target_id,
    status: r.status as ActionStatus,
    source: r.source,
    reason: r.reason,
    batchId: r.batch_id,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    executedAt: r.executed_at,
    error: r.error,
    dryRun: r.dry_run === 1,
  };
}

export class ActionsRepo {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 提报候选。插件和筛选器都只能走这里，状态强制为 pending。
   * 已在队列中且未结束的同一目标不会重复插入。
   */
  propose(params: {
    accountId: string;
    kind: ActionKind;
    targetIds: string[];
    source?: string;
    reason?: string;
    batchId?: string;
  }): number {
    const exists = this.db.prepare(`
      SELECT 1 AS hit FROM actions
      WHERE account_id = ? AND kind = ? AND target_id = ?
        AND status IN ('pending', 'approved', 'running')
    `);
    const insert = this.db.prepare(`
      INSERT INTO actions (account_id, kind, target_id, status, source, reason, batch_id, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    `);

    const now = nowIso();
    let n = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of params.targetIds) {
        if (exists.get(params.accountId, params.kind, id)) continue;
        insert.run(params.accountId, params.kind, id, params.source ?? null, params.reason ?? null, params.batchId ?? null, now);
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  list(status?: ActionStatus, limit = 500): Action[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM actions WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as unknown as ActionRow[]).map(toDomain);
  }

  get(id: number): Action | null {
    const r = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
    return r ? toDomain(r) : null;
  }

  approve(ids: number[]): number {
    const stmt = this.db.prepare(`
      UPDATE actions SET status = 'approved', approved_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    let n = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) n += Number(stmt.run(nowIso(), id).changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /** 驳回：pending 和已批准但还没执行都可以撤回。 */
  reject(ids: number[]): number {
    const stmt = this.db.prepare(`
      UPDATE actions SET status = 'skipped', error = 'rejected by user'
      WHERE id = ? AND status IN ('pending', 'approved')
    `);
    let n = 0;
    for (const id of ids) n += Number(stmt.run(id).changes);
    return n;
  }

  /** 还没进执行器的任务 */
  listOpen(): Action[] {
    const rows = this.db.prepare(`
      SELECT * FROM actions WHERE status IN ('pending', 'approved') ORDER BY id ASC
    `).all() as unknown as ActionRow[];
    return rows.map(toDomain);
  }

  /** 取一条 approved，置为 running。用一条 UPDATE ... RETURNING 完成，避免两个进程抢同一条。 */
  claimNext(): Action | null {
    const row = this.db.prepare(`
      UPDATE actions SET status = 'running', executed_at = ?
      WHERE id = (
        SELECT id FROM actions WHERE status = 'approved' ORDER BY id ASC LIMIT 1
      ) AND status = 'approved'
      RETURNING *
    `).get(nowIso()) as unknown as ActionRow | undefined;
    return row ? toDomain(row) : null;
  }

  finish(id: number, ok: boolean, opts: { error?: string; dryRun?: boolean } = {}): void {
    this.db.prepare(`
      UPDATE actions SET status = ?, error = ?, executed_at = ?, dry_run = ? WHERE id = ?
    `).run(ok ? 'done' : 'failed', opts.error ?? null, nowIso(), opts.dryRun ? 1 : 0, id);
  }

  skip(id: number, reason: string): void {
    this.db.prepare(`
      UPDATE actions SET status = 'skipped', error = ?, executed_at = ? WHERE id = ?
    `).run(reason, nowIso(), id);
  }

  /** 把已领取但还没执行的任务放回 approved（比如配额到了，留到明天）。 */
  release(id: number): void {
    this.db.prepare(`
      UPDATE actions SET status = 'approved', executed_at = NULL WHERE id = ? AND status = 'running'
    `).run(id);
  }

  /** 进程退出时把 running 放回 approved，避免任务卡死。 */
  resetRunning(): number {
    return Number(this.db.prepare(`
      UPDATE actions SET status = 'approved', executed_at = NULL WHERE status = 'running'
    `).run().changes);
  }

  stats(): { pending: number; approved: number; running: number; done: number; failed: number; skipped: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM actions GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    const out = { pending: 0, approved: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const r of rows) {
      if (r.status in out) out[r.status as keyof typeof out] = r.n;
    }
    return out;
  }

  // ---- 配额 ----

  usedToday(accountId: string, kind: ActionKind): number {
    const r = this.db.prepare(`
      SELECT used FROM daily_quota WHERE account_id = ? AND day = ? AND kind = ?
    `).get(accountId, todayLocal(), kind) as { used: number } | undefined;
    return r?.used ?? 0;
  }

  consumeQuota(accountId: string, kind: ActionKind, n = 1): void {
    this.db.prepare(`
      INSERT INTO daily_quota (account_id, day, kind, used)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, day, kind) DO UPDATE SET used = used + excluded.used
    `).run(accountId, todayLocal(), kind, n);
  }

  /** 最近一小时真正执行了多少条。dry-run 不算。 */
  usedLastHour(accountId: string, kind: ActionKind): number {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n FROM actions
      WHERE account_id = ? AND kind = ? AND status = 'done' AND dry_run = 0 AND executed_at >= ?
    `).get(accountId, kind, since) as { n: number } | undefined;
    return r?.n ?? 0;
  }
}
