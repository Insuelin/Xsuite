// 快照读写与 Diff。

import type { Db } from '../client.ts';
import { nowIso } from '../client.ts';
import type { RelationKind, Snapshot } from '../../../shared/domain.ts';

interface SnapshotRow {
  id: number;
  account_id: string;
  kind: string;
  taken_at: string;
  item_count: number;
  expected_min: number | null;
  bottom_cursor: string | null;
  complete: number;
}

function toDomain(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    accountId: r.account_id,
    kind: r.kind as RelationKind,
    takenAt: r.taken_at,
    itemCount: r.item_count,
    expectedMin: r.expected_min,
    bottomCursor: r.bottom_cursor,
    complete: r.complete === 1,
  };
}

export interface DiffResult {
  appeared: string[];
  disappeared: string[];
}

export class SnapshotsRepo {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(accountId: string, kind: RelationKind): number {
    const info = this.db.prepare(`
      INSERT INTO snapshots (account_id, kind, taken_at, item_count, complete)
      VALUES (?, ?, ?, 0, 0)
    `).run(accountId, kind, nowIso());
    return Number(info.lastInsertRowid);
  }

  /** 分块写入明细，千条级别能压到几毫秒。 */
  addMembers(snapshotId: number, userIds: string[]): void {
    if (userIds.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO snapshot_members (snapshot_id, user_id, position) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = userIds.slice(i, i + 500);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        chunk.forEach((uid, idx) => stmt.run(snapshotId, uid, i + idx));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  finalize(
    snapshotId: number,
    info: { itemCount: number; expectedMin: number | null; bottomCursor: string | null; complete: boolean },
  ): void {
    this.db.prepare(`
      UPDATE snapshots
      SET item_count = ?, expected_min = ?, bottom_cursor = ?, complete = ?
      WHERE id = ?
    `).run(info.itemCount, info.expectedMin, info.bottomCursor, info.complete ? 1 : 0, snapshotId);
  }

  get(id: number): Snapshot | null {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
    return r ? toDomain(r) : null;
  }

  getLastComplete(accountId: string, kind: RelationKind): Snapshot | null {
    const r = this.db.prepare(`
      SELECT * FROM snapshots
      WHERE account_id = ? AND kind = ? AND complete = 1
      ORDER BY id DESC LIMIT 1
    `).get(accountId, kind) as SnapshotRow | undefined;
    return r ? toDomain(r) : null;
  }

  memberIds(snapshotId: number): Set<string> {
    const rows = this.db
      .prepare('SELECT user_id FROM snapshot_members WHERE snapshot_id = ?')
      .all(snapshotId) as { user_id: string }[];
    return new Set(rows.map((r) => r.user_id));
  }

  diff(fromId: number, toId: number): DiffResult {
    const a = this.memberIds(fromId);
    const b = this.memberIds(toId);
    const appeared: string[] = [];
    const disappeared: string[] = [];
    for (const id of b) if (!a.has(id)) appeared.push(id);
    for (const id of a) if (!b.has(id)) disappeared.push(id);
    return { appeared, disappeared };
  }

  /** 记录变化。归因由调用方决定（self_action / account_abnormal / disappeared）。 */
  recordChange(params: {
    accountId: string;
    kind: RelationKind;
    userId: string;
    change: string;
    fromSnapshot: number;
    toSnapshot: number;
    actionId?: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO changes (account_id, kind, user_id, change, action_id, detected_at, from_snapshot, to_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.accountId,
      params.kind,
      params.userId,
      params.change,
      params.actionId ?? null,
      nowIso(),
      params.fromSnapshot,
      params.toSnapshot,
    );
  }
}
