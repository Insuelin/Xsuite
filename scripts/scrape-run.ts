// 抓取一次关系列表，写入快照并做 diff。
// 用法：node scripts/scrape-run.ts --kind following [--max-scrolls 100]

import { config } from '../src/core/config.ts';
import { openDb } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { connectEdge } from '../src/core/cdp/connect.ts';
import { WorkTab } from '../src/core/cdp/page.ts';
import { runScrapeJob } from '../src/core/jobs/scrape-job.ts';
import type { RelationKind } from '../src/shared/domain.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const kind = arg('kind', 'following') as RelationKind;
const maxScrolls = Number(arg('max-scrolls', '100'));

async function main() {
  const db = openDb(config.dbFile);
  migrate(db);

  const conn = await connectEdge(config.edgePortFile);
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有浏览器上下文');

  const work = new WorkTab(ctx);
  const page = await work.ensure();

  const result = await runScrapeJob({
    db,
    page,
    kind,
    maxScrolls,
    log: (m) => console.log(m),
  });

  const elapsed = (result.elapsedMs / 1000).toFixed(1);
  console.log(`\n耗时 ${elapsed}s，users 表共 ${(db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n} 条`);

  await work.close().catch(() => {});
  // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
  db.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
