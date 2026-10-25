// 打开某个用户主页的「更多」菜单，把里面所有 data-testid 打出来。
// 只是打开菜单看一眼，什么状态都不改。用完自己关标签页。
//
// 用法：node scripts/dev/inspect-menu.ts 3693982692

import { connectEdge } from '../../src/core/cdp/connect.ts';
import { config } from '../../src/core/config.ts';

async function main() {
  const userId = process.argv[2];
  if (!userId) throw new Error('用法：node scripts/dev/inspect-menu.ts <userId>');

  const { browser } = await connectEdge(config.edgePortFile);
  const page = await browser.contexts()[0]!.newPage();

  try {
    await page.goto(`https://x.com/i/user/${userId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector('[data-testid="userActions"]', { timeout: 20_000 });
    await page.waitForTimeout(800);

    // 主页上直接能看到的按钮
    const direct = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid]')]
        .map((el) => ({
          id: el.getAttribute('data-testid') ?? '',
          text: (el.textContent ?? '').trim().slice(0, 24),
          tag: el.tagName.toLowerCase(),
        }))
        .filter((e) => /follow|unfollow|mute|block|userActions|editProfile/i.test(e.id)),
    );
    console.log('主页上直接可见的：');
    for (const d of direct) console.log(`  ${d.id.padEnd(40)} ${d.tag}  "${d.text}"`);

    // 打开「更多」菜单
    await page.locator('[data-testid="userActions"]').first().click();
    await page.waitForTimeout(1200);

    const menu = await page.evaluate(() => {
      const layers = [...document.querySelectorAll('[data-testid="Dropdown"]')];
      const root = layers[layers.length - 1] ?? document.body;
      return [...root.querySelectorAll('[data-testid], [role="menuitem"]')].map((el) => ({
        id: el.getAttribute('data-testid') ?? `(role=${el.getAttribute('role')})`,
        text: (el.textContent ?? '').trim().slice(0, 30),
      }));
    });
    console.log('\n「更多」菜单里的：');
    for (const m of menu) console.log(`  ${m.id.padEnd(40)} "${m.text}"`);

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  } finally {
    await page.close().catch(() => {});
  }

  console.log('\n看完关掉了。');
  process.exit(0);
}

main().catch((e) => {
  console.error('失败：', (e as Error).message);
  process.exit(1);
});
