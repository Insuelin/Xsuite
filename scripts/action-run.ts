// 执行队列：连上 Edge，把 approved 的任务逐条做完。
//
// 用法：
//   node scripts/action-run.ts                 dry-run，只走流程不真点
//   node scripts/action-run.ts --confirm       真执行
//   node scripts/action-run.ts --confirm --limit 20

import { config } from '../src/core/config.ts';
import { openDb } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { connectEdge } from '../src/core/cdp/connect.ts';
import { WorkTab } from '../src/core/cdp/page.ts';
import { BrowserMutex } from '../src/core/scheduler/mutex.ts';
import { runActionQueue } from '../src/core/actions/worker.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const confirm = has('confirm');
const dryRun = !confirm || config.dryRun;
const limit = arg('limit') ? Number(arg('limit')) : undefined;

async function main() {
  const db = openDb(config.dbFile);
  migrate(db);

  const account = db.prepare('SELECT id, handle FROM accounts LIMIT 1').get() as
    | { id: string; handle: string }
    | undefined;
  if (!account) throw new Error('accounts 表是空的，先跑一次抓取');

  console.log(`账号: @${account.handle}`);
  console.log(`模式: ${dryRun ? 'dry-run（不会真的点）' : '真实执行'}`);
  console.log(`限速: ${config.action.minGapMs / 1000}-${config.action.maxGapMs / 1000} 秒/条，每日上限 ${config.action.perDay} 条\n`);

  const conn = await connectEdge(config.edgePortFile);
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有浏览器上下文');

  const work = new WorkTab(ctx);
  if (!(await work.isLoggedIn())) throw new Error('没有登录 x.com');

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\n收到 Ctrl+C，做完当前这条就停……');
    controller.abort();
  });

  const page = await work.ensure();
  const result = await runActionQueue({
    db,
    accountId: account.id,
    page,
    dryRun,
    mutex: new BrowserMutex(),
    maxActions: limit,
    signal: controller.signal,
    log: (m) => console.log(m),
    // 队列状态事件，顺便验证 worker 确实在发
    onEvent: (e) => {
      if (e.type === 'queue:progress') {
        console.log(`    [事件] 待批 ${e.pending} · 已批 ${e.approved} · 完成 ${e.done} · 失败 ${e.failed}`);
      }
    },
  });

  console.log(`\n结束原因: ${result.stoppedBy}${result.reason ? `（${result.reason}）` : ''}`);
  console.log(`  执行 ${result.attempted} · 成功 ${result.done} · 失败 ${result.failed} · 跳过 ${result.skipped}`);
  if (dryRun && result.done > 0) console.log('  dry-run 没有动本地关系状态，也没占配额');

  await work.close().catch(() => {});
  // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
  db.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
