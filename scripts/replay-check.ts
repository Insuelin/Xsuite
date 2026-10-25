// 回放器的离线自检。不需要浏览器，纯粹验几何和时间。
//
// 用法：node scripts/replay-check.ts
//
// 验四件事：
//   1. 贴上去之后第一点正好在起点、最后一点正好落在目标上
//   2. 扰动不移动两个端点
//   3. 相似变换不改变轨迹形状（切向/法向比例），只改尺寸和朝向
//   4. 语料挑选不越界、不重复

import { Corpus } from '../src/core/replay/corpus.ts';
import { addJitter, fitSegment, sampleLanding, scaleRatio, timeScaleFor, warpTime } from '../src/core/replay/transform.ts';
import { makeRng } from '../src/core/replay/pointer.ts';
import { memoryStore } from '../src/core/replay/types.ts';
import type { Sample } from '../src/core/replay/types.ts';

const rng = makeRng(20261025);
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const corpus = Corpus.load('data/trajectories', ['sapimouse', 'guidaeta']);
if (corpus.size === 0) {
  console.error('语料是空的，先跑 node scripts/build-segments.ts');
  process.exit(1);
}

console.log(`语料 ${corpus.size} 段，数据集 ${corpus.datasets.join(' / ')}\n`);

// --- 1 & 2：端点精确、扰动不动端点 ---
{
  let worstStart = 0;
  let worstEnd = 0;
  let worstJitterEnd = 0;
  let degenerate = 0;

  for (let i = 0; i < 300; i++) {
    const from = { x: rng() * 1400 + 100, y: rng() * 700 + 50 };
    const to = { x: rng() * 1400 + 100, y: rng() * 700 + 50 };
    const picked = corpus.pick({ dist: Math.hypot(to.x - from.x, to.y - from.y), used: memoryStore(), rng });
    if (!picked) {
      degenerate++;
      continue;
    }

    const pts: Sample[] = picked.segment.pts.map(([x, y, t]) => ({ x, y, t }));
    const fitted = fitSegment(pts, from, to, rng() < 0.5);

    worstStart = Math.max(worstStart, Math.hypot(fitted[0]!.x - from.x, fitted[0]!.y - from.y));
    const z = fitted[fitted.length - 1]!;
    worstEnd = Math.max(worstEnd, Math.hypot(z.x - to.x, z.y - to.y));

    const jittered = addJitter(fitted, 1.2, rng);
    const jz = jittered[jittered.length - 1]!;
    worstJitterEnd = Math.max(worstJitterEnd, Math.hypot(jz.x - to.x, jz.y - to.y));
    const j0 = jittered[0]!;
    worstStart = Math.max(worstStart, Math.hypot(j0.x - from.x, j0.y - from.y));
  }

  check('起点误差 < 0.001 px', worstStart < 0.001, `实测 ${worstStart.toFixed(6)}`);
  check('终点误差 < 0.001 px', worstEnd < 0.001, `实测 ${worstEnd.toFixed(6)}`);
  check('扰动后终点不动', worstJitterEnd < 0.001, `实测 ${worstJitterEnd.toFixed(6)}`);
  if (degenerate > 0) console.log(`  （${degenerate} 次没挑到，属正常，候选池会耗尽）`);
}

// --- 3：相似变换保持形状 ---
{
  const picked = corpus.pick({ dist: 400, used: memoryStore(), rng })!;
  const pts: Sample[] = picked.segment.pts.map(([x, y, t]) => ({ x, y, t }));

  // 取几个非端点的转角，比较变换前后的夹角
  const angleAt = (p: Sample[], i: number) => {
    const a = p[i - 1]!;
    const b = p[i]!;
    const c = p[i + 1]!;
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };

  const from = { x: 300, y: 200 };
  const to = { x: 900, y: 620 };
  const fitted = fitSegment(pts, from, to, false);
  const ratio = scaleRatio(pts, from, to);

  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    worst = Math.max(worst, Math.abs(angleAt(pts, i) - angleAt(fitted, i)));
  }
  check('转角在变换前后一致', worst < 1e-6, `最大偏差 ${worst.toExponential(2)} rad`);

  // 各向同性：任意两点距离都按同一系数放大
  const d0 = Math.hypot(pts[2]!.x - pts[0]!.x, pts[2]!.y - pts[0]!.y);
  const d1 = Math.hypot(fitted[2]!.x - fitted[0]!.x, fitted[2]!.y - fitted[0]!.y);
  check('各点间距按同一系数缩放', Math.abs(d1 / d0 - ratio) < 1e-6, `期望 ${ratio.toFixed(4)}，实测 ${(d1 / d0).toFixed(4)}`);
}

// --- 4：挑选不越界 ---
{
  const used = memoryStore();
  let outOfRange = 0;
  let repeated = 0;
  const seen = new Set<string>();
  let picked = 0;

  for (let i = 0; i < 500; i++) {
    const dist = 100 + rng() * 900;
    const r = corpus.pick({ dist, used, rng });
    if (!r) break;
    picked++;
    if (r.scale < 0.75 - 1e-9 || r.scale > 1.25 + 1e-9) outOfRange++;
    if (seen.has(r.segment.id)) repeated++;
    seen.add(r.segment.id);
    used.add(r.segment.id);
  }

  check('缩放系数都在 ±25% 以内', outOfRange === 0, `${outOfRange} 条越界`);
  check('同一个集合里不重复', repeated === 0, `${repeated} 条重复`);
  console.log(`  （挑了 ${picked} 条后候选池状态正常）`);
}

// --- 5：时间轴 ---
{
  const picked = corpus.pick({ dist: 500, used: memoryStore(), rng })!;
  const pts: Sample[] = picked.segment.pts.map(([x, y, t]) => ({ x, y, t }));
  const factor = timeScaleFor(picked.segment.dist, picked.segment.dist * 1.2);
  const warped = warpTime(pts, factor);

  const monotonic = warped.every((p, i) => i === 0 || p.t >= warped[i - 1]!.t);
  const ratio = warped[warped.length - 1]!.t / pts[pts.length - 1]!.t;
  check('时间单调不回退', monotonic);
  check('时间缩放生效', Math.abs(ratio - factor) < 1e-9, `期望 ${factor.toFixed(4)}，实测 ${ratio.toFixed(4)}`);
  check('Fitts 修正幅度很小', factor > 0.95 && factor < 1.1, `1.2 倍距离对应 ${factor.toFixed(4)}`);
}

// --- 6：落点采样在框内 ---
{
  const rect = { x: 100, y: 200, width: 120, height: 36 };
  let outside = 0;
  let meanX = 0;
  let meanY = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const p = sampleLanding(rect, rng);
    if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) outside++;
    meanX += p.x / N;
    meanY += p.y / N;
  }
  check('落点全部在元素内', outside === 0, `${outside} 个越界`);
  check(
    '落点均值靠近中心',
    Math.abs(meanX - (rect.x + rect.width / 2)) < 4 && Math.abs(meanY - (rect.y + rect.height / 2)) < 3,
  );
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
