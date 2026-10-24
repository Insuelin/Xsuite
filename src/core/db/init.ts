// 初始化数据库：建表 + 迁移 + FTS5 自检。
// 用法：node src/core/db/init.ts

import { openDb, checkFts5 } from './client.ts';
import { migrate } from './migrate.ts';
import { config } from '../config.ts';

const db = openDb(config.dbFile);
const result = migrate(db);
const fts = checkFts5(db);

console.log(`数据库: ${config.dbFile}`);
console.log(`schema: v${result.from} → v${result.to}`);
console.log(`SQLite ${fts.version} · FTS5+trigram: ${fts.ok ? 'OK' : '不可用 — ' + fts.error}`);

const counts = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__fts%'
  ORDER BY name
`).all() as { name: string }[];

console.log(`表 (${counts.length}): ${counts.map((t) => t.name).join(', ')}`);
db.close();
