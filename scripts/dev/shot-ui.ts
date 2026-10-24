// 诊断用：在自己的 Edge 里开一个临时标签页，给本地界面截图，然后关掉。
// 用法：node scripts/dev/shot-ui.ts [路径] [输出文件名]

import path from 'node:path';
import { config } from '../../src/core/config.ts';
import { connectEdge } from '../../src/core/cdp/connect.ts';

const route = process.argv[2] ?? '/';
const name = process.argv[3] ?? 'overview';

const conn = await connectEdge(config.edgePortFile);
const ctx = conn.browser.contexts()[0];
if (!ctx) throw new Error('没有浏览器上下文');

const page = await ctx.newPage();
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:7420/${route.replace(/^\//, '')}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await page.waitForTimeout(1200);
  const out = path.join(config.dataDir, 'screenshots', `ui-${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
} finally {
  await page.close().catch(() => {});
  process.exit(0);
}
