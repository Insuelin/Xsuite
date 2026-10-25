// 真机自检：连用户的 Edge，在自己开的标签页上跑回放，把 DOM 实际收到的
// 事件读回来，和 Playwright 原生点击对照。
//
// 用法：
//   node scripts/replay-live.ts                    在自造的静态页上测五个按钮
//   node scripts/replay-live.ts --x elshayib_      在真实 X 页面上取关 → 关注
//   node scripts/replay-live.ts --x elshayib_ --follow-only
//
// X 模式会真的改动账号状态，跑完会把状态恢复成原样（取关后补一次关注）。
// 不调 browser.close()，只关自己开的那一页。

import { connectEdge } from '../src/core/cdp/connect.ts';
import { config } from '../src/core/config.ts';
import { followUser, unfollowUser } from '../src/core/cdp/actions.ts';
import { openDb } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { ReplayRepo } from '../src/core/db/repos/replay.repo.ts';
import { currentSubjectPoolLabel, getCorpus, selectSubjects } from '../src/core/replay/index.ts';
import { memoryStore } from '../src/core/replay/types.ts';

interface DomEvent {
  type: string;
  x: number;
  y: number;
  t: number;
  trusted: boolean;
}

const RECORDER = () => {
  const w = window as unknown as { __ev: DomEvent[] };
  w.__ev = [];
  for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(
      type,
      (e) => {
        const m = e as MouseEvent;
        w.__ev.push({
          type,
          x: Math.round(m.clientX * 100) / 100,
          y: Math.round(m.clientY * 100) / 100,
          t: Math.round(performance.now() * 100) / 100,
          trusted: m.isTrusted,
        });
      },
      true,
    );
  }
};

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#f6f6f7;font-family:system-ui}
  button{position:absolute;font:14px system-ui;padding:8px 16px;border:1px solid #ccc;
         border-radius:8px;background:#fff;cursor:pointer}
  #b1{left:900px;top:240px;width:100px;height:34px}
  #b2{left:320px;top:610px;width:90px;height:30px}
  #b3{left:1000px;top:90px;width:80px;height:28px}
  #b4{left:150px;top:420px;width:140px;height:36px}
  #b5{left:700px;top:700px;width:90px;height:30px}
  #b6{left:600px;top:150px;width:70px;height:26px}
</style></head><body>
<button id="b1">一</button><button id="b2">二</button><button id="b3">三</button>
<button id="b4">四</button><button id="b5">五</button><button id="b6">原生</button>
</body></html>`;

/** 只保留最后一次 mousedown 之前的那一段，避免把别的鼠标动作算进来 */
function summarise(evs: DomEvent[]): string {
  const down = evs.find((e) => e.type === 'mousedown');
  if (!down) return '没抓到 mousedown';

  const up = evs.find((e) => e.type === 'mouseup' && e.t >= down.t);
  // 从上一个 mouseup 之后算起，切掉之前残留的移动
  const prevUp = [...evs].reverse().find((e) => e.type === 'mouseup' && e.t < down.t);
  const from = prevUp ? prevUp.t : -Infinity;
  const moves = evs.filter((e) => e.type === 'mousemove' && e.t > from && e.t <= down.t);
  const click = evs.find((e) => e.type === 'click' && e.t >= down.t);

  let path = 0;
  for (let i = 1; i < moves.length; i++) {
    path += Math.hypot(moves[i]!.x - moves[i - 1]!.x, moves[i]!.y - moves[i - 1]!.y);
  }
  const gaps: number[] = [];
  for (let i = 1; i < moves.length; i++) gaps.push(moves[i]!.t - moves[i - 1]!.t);
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)]!.toFixed(0) : '—';
  const last = moves[moves.length - 1];
  const settle = last ? Math.round(down.t - last.t) : null;
  const dwell = up ? Math.round(up.t - down.t) : null;
  const trusted = evs.filter((e) => e.t >= from).every((e) => e.trusted);

  return (
    `移动 ${moves.length} 帧，路径 ${path.toFixed(0)}px，间隔中位 ${med}ms，` +
    `末帧→按下 ${settle ?? '—'}ms，按压 ${dwell ?? '—'}ms，` +
    `click ${click ? '有' : '无'}，isTrusted ${trusted ? '全部' : '有假'}，` +
    `落点 (${down.x}, ${down.y})`
  );
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readEvents(page: import('playwright-core').Page): Promise<DomEvent[]> {
  return (
    (await page.evaluate(() => (window as never as { __ev: DomEvent[] }).__ev).catch(() => [])) ?? []
  );
}

// ---------------------------------------------------------------- 本地静态页

async function localMode(page: import('playwright-core').Page): Promise<void> {
  const { humanClick } = await import('../src/core/replay/index.ts');
  await page.setContent(TEST_PAGE);
  // setContent 不是导航，addInitScript 不会触发，得手动装一次
  await page.evaluate(RECORDER);
  await page.waitForTimeout(300);

  const used = memoryStore();
  console.log('=== 真人轨迹回放 ===');
  for (const sel of ['#b1', '#b2', '#b3', '#b4', '#b5']) {
    const before = await readEvents(page);
    const t0 = Date.now();
    const res = await humanClick(page, page.locator(sel), { used, subjectOffset: 0 });
    const elapsed = Date.now() - t0;
    const evs = (await readEvents(page)).slice(before.length);
    console.log(`  ${sel.padEnd(4)} ${summarise(evs)}`);
    console.log(
      `       → ${res.replay ? `回放 ${res.segmentId} (${res.subject})` : '兜底'} ` +
        `总耗时 ${elapsed}ms 缩放 ${(res.scale ?? 1).toFixed(2)}`,
    );
  }

  console.log('\n=== Playwright 原生点击（对照组）===');
  {
    const before = await readEvents(page);
    await page.locator('#b6').click();
    const evs = (await readEvents(page)).slice(before.length);
    console.log(`  #b6  ${summarise(evs)}`);
  }
}

// ---------------------------------------------------------------- 真实 X 页面

async function xMode(page: import('playwright-core').Page, handle: string): Promise<void> {
  const db = openDb(config.dbFile);
  migrate(db);
  const used = new ReplayRepo(db, config.replay.reuseAfterDays);

  const user = db.prepare('SELECT id, handle FROM users WHERE lower(handle)=lower(?)').get(handle) as
    | { id: string; handle: string }
    | undefined;
  if (!user) throw new Error(`数据库里没有 @${handle}，先抓一次名单`);

  const mode = process.argv.includes('--follow-only')
    ? 'follow'
    : process.argv.includes('--unfollow-only')
      ? 'unfollow'
      : 'both';

  console.log(`目标 @${user.handle} (id ${user.id})`);
  console.log(`回放绑定：${currentSubjectPoolLabel(0) ?? '未启用'}`);
  console.log(`冷却期 ${config.replay.reuseAfterDays} 天，当前占住 ${used.count()} 条\n`);

  const opts = { dryRun: false, screenshotDir: `${config.dataDir}/screenshots`, used };

  if (mode === 'both' || mode === 'unfollow') {
    console.log('=== 取关 ===');
    const before = await readEvents(page);
    const t0 = Date.now();
    const res = await unfollowUser(page, user.id, opts);
    const evs = (await readEvents(page)).slice(before.length);
    console.log(`  结果 ok=${res.ok} ${res.error ?? ''} 回放=${res.replay} 耗时 ${Date.now() - t0}ms`);
    console.log(`  事件 ${summarise(evs)}`);
    await page.waitForTimeout(2500);
  }

  if (mode === 'both' || mode === 'follow') {
    console.log('\n=== 关注 ===');
    const before = await readEvents(page);
    const t0 = Date.now();
    const res = await followUser(page, user.id, opts);
    const evs = (await readEvents(page)).slice(before.length);
    console.log(`  结果 ok=${res.ok} ${res.error ?? ''} 回放=${res.replay} 耗时 ${Date.now() - t0}ms`);
    console.log(`  事件 ${summarise(evs)}`);
  }

  console.log(`\n用过的段累计 ${used.count()} 条`);
}

// ---------------------------------------------------------------- 入口

async function main() {
  const corpus = getCorpus();
  if (!corpus) throw new Error('语料没加载，先跑 node scripts/build-segments.ts');

  const handle = flagValue('x');
  if (handle) {
    const pools = selectSubjects(corpus);
    console.log(`语料 ${corpus.size} 段，本次绑 ${[...(pools.subjectPool ?? [])].join(',') || '(未绑)'}`);
  } else {
    console.log(`语料 ${corpus.size} 段`);
  }

  console.log('连接 Edge…');
  const { browser, pages } = await connectEdge(config.edgePortFile);
  console.log(`连上了，现有 ${pages} 个页面\n`);

  const page = await browser.contexts()[0]!.newPage();
  await page.addInitScript(RECORDER);

  try {
    if (handle) await xMode(page, handle);
    else await localMode(page);
  } finally {
    // 只关自己这一页，不碰用户的其它标签页，也绝不 close browser
    await page.close().catch(() => {});
  }

  console.log('\n测完，已关闭自己开的标签页。');
  process.exit(0);
}

main().catch((err) => {
  console.error('失败：', (err as Error).message);
  process.exit(1);
});
