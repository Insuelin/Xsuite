// 辅助脚本：从自己的关注列表里找出前几个用户的数字 ID，用于 dry-run 测试。
// 用法：node scripts/find-test-user.ts

import { config } from '../src/core/config.ts';
import { openDb } from '../src/core/db/client.ts';
import { connectEdge } from '../src/core/cdp/connect.ts';
import { WorkTab } from '../src/core/cdp/page.ts';
import { URLS } from '../src/core/cdp/selectors.ts';

async function main() {
  const db = openDb(config.dbFile);
  const conn = await connectEdge(config.edgePortFile);
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有可用的浏览器上下文');

  const work = new WorkTab(ctx);
  const page = await work.ensure();

  // 1. 找自己的 handle
  await page.goto(URLS.home, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3000);

  let handle: string | null = null;
  try {
    const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href', { timeout: 5000 });
    if (href) handle = href.replace(/^\//, '');
  } catch { /* ignore */ }

  if (!handle) {
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/"]')]
        .map((a) => (a as HTMLAnchorElement).getAttribute('href') || '')
        .filter((h) => /^\/[A-Za-z0-9_]+$/.test(h))
        .slice(0, 10),
    );
    console.log('没拿到 Profile 链接，页面上的候选链接：', links);
  }
  console.log('自己的 handle:', handle ?? '未知');

  if (!handle) {
    await conn.browser.close();
    db.close();
    return;
  }

  // 2. 打开关注列表
  await page.goto(URLS.following(handle), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000);

  // 3. 读按钮 testid
  const testIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid') || '')
      .filter((id) => id.endsWith('-unfollow') || id.endsWith('-follow'))
      .slice(0, 30),
  );

  console.log(`\n找到 ${testIds.length} 个关注按钮相关 testid:`);
  for (const id of testIds) console.log('  ' + id);

  const userIds = testIds
    .map((id) => id.replace(/-(unfollow|follow)$/, ''))
    .filter((id) => /^\d+$/.test(id));

  console.log(`\n可用的数字 user_id（前 5 个）: ${userIds.slice(0, 5).join(', ')}`);

  // 4. 顺带看一眼 UserCell 里有没有别的 ID 属性
  const cellSample = await page.evaluate(() => {
    const cell = document.querySelector('[data-testid="UserCell"]');
    if (!cell) return null;
    return cell.outerHTML.slice(0, 1500);
  });
  if (cellSample) {
    console.log('\nUserCell 外层 HTML 摘录:\n' + cellSample);
  }

  await conn.browser.close();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
