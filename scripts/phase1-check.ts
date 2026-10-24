// Phase 1 验证脚本：数据库 → 连 Edge → 登录态 → Dry-run 取关。
// 用法：
//   node scripts/phase1-check.ts
//   node scripts/phase1-check.ts --user 123456789
//   node scripts/phase1-check.ts --user 123456789 --confirm   危险，会真的取关

import path from 'node:path';
import { config } from '../src/core/config.ts';
import { openDb, checkFts5 } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { UsersRepo } from '../src/core/db/repos/users.repo.ts';
import { connectEdge } from '../src/core/cdp/connect.ts';
import { WorkTab } from '../src/core/cdp/page.ts';
import { unfollowUser } from '../src/core/cdp/actions.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const userId = arg('user');
const confirm = has('confirm');
const screenshotDir = arg('shot') ?? path.join(config.dataDir, 'screenshots');

async function main() {
  console.log('=== 1. 数据库 ===');
  const db = openDb(config.dbFile);
  const m = migrate(db);
  const fts = checkFts5(db);
  console.log(`  ${config.dbFile}`);
  console.log(`  schema v${m.from} → v${m.to}`);
  console.log(`  SQLite ${fts.version} · FTS5+trigram ${fts.ok ? 'OK' : '不可用: ' + fts.error}`);

  const users = new UsersRepo(db);
  console.log(`  users 表当前 ${(db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n} 条`);

  console.log('\n=== 2. 连接 Edge ===');
  let conn;
  try {
    conn = await connectEdge(config.edgePortFile);
  } catch (err) {
    console.error('  ' + (err instanceof Error ? err.message : String(err)));
    db.close();
    process.exit(1);
  }
  console.log(`  已连接，端口 ${conn.port}，上下文 ${conn.contexts} 个，页面 ${conn.pages} 个`);

  console.log('\n=== 3. 工作标签页与登录态 ===');
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有可用的浏览器上下文');
  const work = new WorkTab(ctx);
  const loggedIn = await work.isLoggedIn();
  console.log(`  登录态: ${loggedIn ? '已登录' : '未登录（请先在 Edge 里登录 x.com）'}`);
  if (!loggedIn) {
    // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
    db.close();
    process.exit(1);
  }

  if (!userId) {
    console.log('\n=== 4. Dry-run ===');
    console.log('  未指定 --user，跳过。示例：node scripts/phase1-check.ts --user 123456789');
    // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
    db.close();
    return;
  }

  console.log(`\n=== 4. ${confirm ? '真实取关' : 'Dry-run'} @ ${userId} ===`);
  const page = await work.ensure();
  const res = await unfollowUser(page, userId, { dryRun: !confirm, screenshotDir });

  console.log(`  ok=${res.ok} dryRun=${res.dryRun}`);
  if (res.error) console.log(`  error: ${res.error}`);
  if (res.screenshot) console.log(`  截图: ${res.screenshot}`);
  if (res.foundTestIds?.length) {
    console.log('  页面上带 data-testid 的元素（前 40）：');
    for (const id of res.foundTestIds) console.log(`    ${id}`);
  }

  if (confirm && res.ok) {
    const u = users.get(userId);
    console.log(`  本地记录: ${u ? `@${u.handle} ${u.name ?? ''}` : '（users 表里还没有此人）'}`);
  }

  // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
  db.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
