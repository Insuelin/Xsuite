// 记录轨迹段用没用在「最近」这段时间里。
//
// 不要求永不复用。检测器能看到的历史最多到几十天，超过这个冷却期，
// 同一条轨迹再出现一次没有任何意义——真人几年的鼠标轨迹里重复形状本来就多。
//
// 冷却期内不复用，是为了避开「同一个会话/同一周里两次一模一样」这个最好抓的点。

import type { Db } from '../client.ts';
import { nowIso } from '../client.ts';
import type { UsedStore } from '../../replay/types.ts';

export class ReplayRepo implements UsedStore {
  private readonly db: Db;
  /** segment_id → 上次使用的毫秒时间戳 */
  private readonly lastUsed = new Map<string, number>();
  private readonly cooldownMs: number;

  constructor(db: Db, cooldownDays: number) {
    this.db = db;
    this.cooldownMs = Math.max(0, cooldownDays) * 86_400_000;

    const rows = db.prepare('SELECT segment_id, used_at FROM replay_used').all() as unknown as {
      segment_id: string;
      used_at: string;
    }[];
    for (const r of rows) {
      const t = Date.parse(r.used_at);
      if (Number.isFinite(t)) this.lastUsed.set(r.segment_id, t);
    }
  }

  /** 冷却期内的算用过，过期的当作没用过 */
  has(id: string): boolean {
    const t = this.lastUsed.get(id);
    if (t === undefined) return false;
    if (this.cooldownMs === 0) return true;
    return Date.now() - t < this.cooldownMs;
  }

  add(id: string, meta?: { dataset?: string; subject?: string }): void {
    this.addMany([{ id, ...meta }]);
  }

  addMany(items: { id: string; dataset?: string; subject?: string }[]): void {
    const now = Date.now();
    const fresh = items.filter((i) => !this.has(i.id));
    if (fresh.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO replay_used(segment_id, subject, dataset, used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(segment_id) DO UPDATE SET used_at = excluded.used_at`,
    );
    const at = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const i of fresh) {
        stmt.run(i.id, i.subject ?? null, i.dataset ?? null, at);
        this.lastUsed.set(i.id, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 冷却期内的条数，也就是「真正被占住」的量 */
  count(): number {
    let n = 0;
    for (const id of this.lastUsed.keys()) if (this.has(id)) n++;
    return n;
  }

  /** 清空记录，冷却从头开始 */
  reset(): void {
    this.db.exec('DELETE FROM replay_used');
    this.lastUsed.clear();
  }

  stats(): {
    total: number;
    cooling: number;
    cooldownDays: number;
    byDataset: Record<string, number>;
    latest: string | null;
  } {
    const rows = this.db
      .prepare('SELECT dataset, COUNT(*) AS n FROM replay_used GROUP BY dataset')
      .all() as unknown as { dataset: string | null; n: number }[];
    const byDataset: Record<string, number> = {};
    for (const r of rows) byDataset[r.dataset ?? 'unknown'] = Number(r.n);
    const last = this.db.prepare('SELECT MAX(used_at) AS t FROM replay_used').get() as
      | { t: string | null }
      | undefined;
    return {
      total: this.lastUsed.size,
      cooling: this.count(),
      cooldownDays: this.cooldownMs / 86_400_000,
      byDataset,
      latest: last?.t ?? null,
    };
  }
}
