// 录制 GraphQL 响应样本，供 parsers 单测使用。
// 用法：node scripts/dev/record-graphql.ts [--kind following|followers|muted|blocked]
// 会打开工作标签页，滚动几次，把拦截到的响应存到 data/samples/<时间戳>/

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/core/config.ts';
import { connectEdge } from '../../src/core/cdp/connect.ts';
import { WorkTab } from '../../src/core/cdp/page.ts';
import { GraphQLInterceptor, type CapturedResponse } from '../../src/core/cdp/interceptor.ts';
import { URLS } from '../../src/core/cdp/selectors.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const kind = arg('kind', 'following');
const rolls = Number(arg('rolls', '6'));

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outDir = path.join(config.dataDir, 'samples', stamp);
fs.mkdirSync(outDir, { recursive: true });

const collected: CapturedResponse[] = [];

async function main() {
  const conn = await connectEdge(config.edgePortFile);
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有浏览器上下文');

  const work = new WorkTab(ctx);
  const page = await work.ensure();

  const interceptor = new GraphQLInterceptor();
  interceptor.attach(page);
  interceptor.on((r) => {
    collected.push(r);
    console.log(`  [${r.kind}] ${r.url.split('/').slice(-2).join('/')} ${JSON.stringify(r.json).length} bytes`);
  });

  // 找自己的 handle
  await page.goto(URLS.home, { waitUntil: 'commit', timeout: 60_000 });
  await page.waitForTimeout(4000);
  let handle = '';
  try {
    const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href', { timeout: 5000 });
    if (href) handle = href.replace(/^\//, '');
  } catch { /* ignore */ }
  if (!handle) throw new Error('拿不到自己的 handle');
  console.log(`handle: ${handle}`);

  const targetUrl =
    kind === 'followers' ? URLS.followers(handle)
    : kind === 'muted' ? URLS.muted
    : kind === 'blocked' ? URLS.blocked
    : URLS.following(handle);

  console.log(`打开 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'commit', timeout: 60_000 });
  await page.waitForTimeout(5000);

  // 滚动触发分页
  for (let i = 0; i < rolls; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(2500 + Math.random() * 1000);
    console.log(`  滚动 ${i + 1}/${rolls}，已拦截 ${collected.length} 个响应`);
  }

  // 落盘
  const index: { kind: string; url: string; file: string; bytes: number }[] = [];
  collected.forEach((r, i) => {
    const name = `${String(i).padStart(3, '0')}-${r.kind}.json`;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, JSON.stringify(r.json, null, 1), 'utf8');
    index.push({ kind: r.kind, url: r.url, file: name, bytes: JSON.stringify(r.json).length });
  });
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  console.log(`\n共 ${collected.length} 个响应，已存 ${outDir}`);
  const byKind = collected.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log('分布:', byKind);

  // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
