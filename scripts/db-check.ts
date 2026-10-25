// 体检本地状态：数据库各表多少行、快照新不新、回放语料在不在。
//
// 用法：node scripts/db-check.ts
//
// 只读，不改任何东西。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/core/config.ts';
import { openDb } from '../src/core/db/client.ts';

function count(db: ReturnType<typeof openDb>, table: string): string {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return String(row.n);
  } catch {
    return '表不存在';
  }
}

function ago(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} 分钟前`;
  if (h < 48) return `${h.toFixed(1)} 小时前`;
  return `${(h / 24).toFixed(1)} 天前`;
}

function main(): void {
  if (!existsSync(config.dbFile)) {
    console.log(`数据库不存在：${config.dbFile}\n先跑 npm run db:init`);
    return;
  }

  const size = (statSync(config.dbFile).size / 1048576).toFixed(1);
  const db = openDb(config.dbFile);

  console.log(`数据库 ${config.dbFile}（${size} MB）`);

  let version = '未初始化';
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    version = String(row.v ?? 0);
  } catch {
    /* 没有 schema_version 就是还没迁移 */
  }
  console.log(`schema 版本 ${version}\n`);

  console.log('表：');
  for (const t of [
    'accounts', 'users', 'relationships', 'snapshots', 'snapshot_members',
    'changes', 'actions', 'whitelist', 'daily_quota',
    'tweets', 'analyses', 'watch_terms', 'term_hits', 'replay_used',
  ]) {
    console.log(`  ${t.padEnd(16)} ${count(db, t)}`);
  }

  console.log('\n最近快照：');
  try {
    const rows = db
      .prepare('SELECT kind, taken_at, item_count, complete FROM snapshots ORDER BY taken_at DESC LIMIT 6')
      .all() as unknown as { kind: string; taken_at: string; item_count: number; complete: number }[];
    if (rows.length === 0) console.log('  （还没有）');
    for (const r of rows) {
      console.log(`  ${r.kind.padEnd(10)} ${String(r.item_count).padStart(6)} 人  ${ago(r.taken_at)}${r.complete ? '' : '  ⚠ 不完整'}`);
    }
  } catch {
    console.log('  （快照表读不了）');
  }

  console.log('\n队列：');
  try {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM actions GROUP BY status")
      .all() as unknown as { status: string; n: number }[];
    if (rows.length === 0) console.log('  （空）');
    for (const r of rows) console.log(`  ${r.status.padEnd(10)} ${r.n}`);
  } catch {
    console.log('  （actions 表读不了）');
  }

  console.log('\n回放语料：');
  const dir = config.replay.dir;
  if (!existsSync(dir)) {
    console.log(`  ${dir} 不存在，跑 npm run fetch:data && npm run segments`);
  } else {
    for (const ds of config.replay.datasets) {
      const seg = join(dir, ds, 'segments.jsonl');
      const subj = join(dir, ds, 'subjects.json');
      if (!existsSync(seg)) {
        console.log(`  ${ds.padEnd(10)} 未构建`);
        continue;
      }
      const lines = readFileSync(seg, 'utf8').split('\n').filter(Boolean).length;
      let people = '?';
      let clusters = '?';
      if (existsSync(subj)) {
        const idx = JSON.parse(readFileSync(subj, 'utf8')) as {
          subjects: Record<string, unknown>;
          clusters: string[][];
        };
        people = String(Object.keys(idx.subjects).length);
        clusters = String(idx.clusters.length);
      }
      const mb = (statSync(seg).size / 1048576).toFixed(1);
      console.log(`  ${ds.padEnd(10)} ${String(lines).padStart(6)} 段 / ${people} 人 / ${clusters} 簇  ${mb} MB`);
    }
  }

  console.log('\n回放占用：');
  try {
    const last = db.prepare('SELECT MAX(used_at) AS t FROM replay_used').get() as { t: string | null };
    const cooling = db
      .prepare('SELECT COUNT(*) AS n FROM replay_used WHERE used_at > ?')
      .get(new Date(Date.now() - config.replay.reuseAfterDays * 86_400_000).toISOString()) as {
      n: number;
    };
    console.log(`  冷却期内 ${cooling.n} 条（总记录 ${count(db, 'replay_used')}，冷却 ${config.replay.reuseAfterDays} 天）`);
    console.log(`  最近一次使用 ${ago(last.t)}`);
  } catch {
    console.log('  （replay_used 表不存在，跑一次 npm run db:init 迁移）');
  }

  console.log(`\n回放开关：${config.replay.enabled ? '开' : '关（XSUITE_REPLAY=0）'}`);
}

main();
