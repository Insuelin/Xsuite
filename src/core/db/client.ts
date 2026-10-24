// SQLite 连接与基础封装。node:sqlite 是同步 API，调用方注意不要长时间阻塞事件循环。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
  `);

  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 分块事务写入。node:sqlite 是同步的，逐条执行会在数据量大时卡住事件循环，
 * 用事务把每 chunk 条包住，千条级别的写入可以降到几毫秒。
 */
export function chunkedInsert<T>(
  db: Db,
  sql: string,
  rows: T[],
  toParams: (row: T) => unknown[],
  chunkSize = 500,
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(sql);

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of chunk) stmt.run(...(toParams(row) as never[]));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** 检查 SQLite 是否支持 FTS5 + trigram，启动时调用一次。 */
export function checkFts5(db: Db): { ok: boolean; version: string; error?: string } {
  const version = String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown');
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x, tokenize='trigram')");
    db.exec('DROP TABLE __fts_probe');
    return { ok: true, version };
  } catch (err) {
    return { ok: false, version, error: err instanceof Error ? err.message : String(err) };
  }
}
