import { config } from '../../src/core/config.ts';
import { connectEdge } from '../../src/core/cdp/connect.ts';
import { WorkTab } from '../../src/core/cdp/page.ts';

const url = process.argv[2] ?? 'https://x.com/settings/blocked/all';

const conn = await connectEdge(config.edgePortFile);
const ctx = conn.browser.contexts()[0];
if (!ctx) throw new Error('no context');
const work = new WorkTab(ctx);
const page = await work.ensure();

const seen = new Set<string>();
page.on('response', (res) => {
  const u = res.url();
  if (!u.includes('/i/api/graphql/')) return;
  const m = u.match(/\/graphql\/([^/]+)\/([^?]+)/);
  const key = m ? `${m[2]}` : u.slice(0, 80);
  if (!seen.has(key)) {
    seen.add(key);
    console.log(key);
  }
});

await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
await page.waitForTimeout(4000);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(2000);
}
console.log('--- total ops:', seen.size);
process.exit(0);
