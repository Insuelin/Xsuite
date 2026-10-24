// 版本化迁移。每次加 schema 变更就新增一个 MIGRATIONS 条目，不要改历史条目。

import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './client.ts';
import { nowIso } from './client.ts';

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const here = import.meta.dirname;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
      db.exec(sql);
    },
  },
];

export function migrate(db: Db): { from: number; to: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  const current = row?.v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(m.version, nowIso());
      db.exec('COMMIT');
      console.log(`[migrate] v${m.version} ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const after = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return { from: current, to: after?.v ?? 0 };
}
