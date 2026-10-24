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

  reject(ids: number[]): number {
    const stmt = this.db.prepare(`
      UPDATE actions SET status = 'skipped', error = 'rejected by user'
      WHERE id = ? AND status = 'pending'
    `);
    let n = 0;
    for (const id of ids) n += Number(stmt.run(id).changes);
    return n;
  }

  /** 取一条 approved，置为 running */
  claimNext(): Action | null {
    const row = this.db.prepare(`
      SELECT * FROM actions WHERE status = 'approved' ORDER BY id ASC LIMIT 1
    `).get() as ActionRow | undefined;
    if (!row) return null;
    this.db.prepare(`
      UPDATE actions SET status = 'running', executed_at = ? WHERE id = ?
    `).run(nowIso(), row.id);
    return { ...toDomain(row), status: 'running' };
  }

  finish(id: number, ok: boolean, error?: string): void {
    this.db.prepare(`
      UPDATE actions SET status = ?, error = ?, executed_at = ? WHERE id = ?
    `).run(ok ? 'done' : 'failed', error ?? null, nowIso(), id);
  }

  skip(id: number, reason: string): void {
    this.db.prepare(`
      UPDATE actions SET status = 'skipped', error = ?, executed_at = ? WHERE id = ?
    `).run(reason, nowIso(), id);
  }

  /** 进程退出时把 running 放回 approved，避免任务卡死。 */
  resetRunning(): number {
    return Number(this.db.prepare(`
      UPDATE actions SET status = 'approved', executed_at = NULL WHERE status = 'running'
    `).run().changes);
  }

  stats(): { pending: number; approved: number; running: number; done: number; failed: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM actions GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    const out = { pending: 0, approved: 0, running: 0, done: 0, failed: 0 };
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
}
