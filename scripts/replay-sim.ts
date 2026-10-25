// 回放器的模拟器：用一个假页面跑完整流程，把发出去的事件流记下来，
// 然后按检测器的视角统计一遍。不开浏览器，不动用户的 Edge。
//
// 用法：node scripts/replay-sim.ts [次数]

import { Corpus } from '../src/core/replay/corpus.ts';
import { selectSubjects } from '../src/core/replay/index.ts';
import { HumanPointer, makeRng } from '../src/core/replay/pointer.ts';
import { memoryStore } from '../src/core/replay/types.ts';
import type { Rect } from '../src/core/replay/types.ts';

interface Sent {
  type: string;
  x: number;
  y: number;
  button: string;
  buttons: number;
  /** 实际发出去的时刻，毫秒 */
  at: number;
}

const sent: Sent[] = [];
const t0 = performance.now();

const fakeSession = {
  async send(method: string, params: Record<string, unknown>) {
    if (method !== 'Input.dispatchMouseEvent') return;
    sent.push({
      type: String(params.type),
      x: Number(params.x),
      y: Number(params.y),
      button: String(params.button),
      buttons: Number(params.buttons),
      at: performance.now() - t0,
    });
  },
  async detach() {},
};

const fakePage = {
  context: () => ({ newCDPSession: async () => fakeSession }),
  evaluate: async () => ({ w: 1280, h: 800 }),
};

function fakeLocator(rect: Rect) {
  return {
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => rect,
  };
}

function quantiles(xs: number[]): string {
  if (xs.length === 0) return 'n=0';
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `n=${s.length} min=${at(0).toFixed(0)} p10=${at(0.1).toFixed(0)} p50=${at(0.5).toFixed(0)} p90=${at(0.9).toFixed(0)} max=${at(s.length - 1).toFixed(0)}`;
}

async function main() {
  const rounds = Number(process.argv[2] ?? 5);
  const corpus = Corpus.load('data/trajectories', ['sapimouse', 'guidaeta']);
  if (corpus.size === 0) throw new Error('语料是空的，先跑 node scripts/build-segments.ts');

  const pools = selectSubjects(corpus);
  console.log(
    `本次绑 ${pools.subjectPool ? [...pools.subjectPool].join(',') : '(未绑)'}，` +
      `退路 ${pools.fallbackPool?.size ?? 0} 人
`,
  );

  const pointer = new HumanPointer(fakePage as never, {
    corpus,
    used: memoryStore(),
    rng: makeRng(42),
    start: { x: 100, y: 100 },
    jitterPx: 1.2,
    ...pools,
  });

  const targets: Rect[] = [
    { x: 900, y: 240, width: 100, height: 32 },
    { x: 320, y: 610, width: 80, height: 30 },
    { x: 1000, y: 90, width: 60, height: 28 },
    { x: 150, y: 420, width: 140, height: 36 },
    { x: 700, y: 700, width: 90, height: 30 },
    { x: 1150, y: 500, width: 70, height: 26 },
  ];

  console.log(`跑 ${rounds} 次点击\n`);

  for (let i = 0; i < rounds; i++) {
    const rect = targets[i % targets.length]!;
    const before = sent.length;
    const report = await pointer.click(fakeLocator(rect) as never);
    const evs = sent.slice(before);

    const moves = evs.filter((e) => e.type === 'mouseMoved');
    const press = evs.find((e) => e.type === 'mousePressed');
    const release = evs.find((e) => e.type === 'mouseReleased');

    const lastMoveBeforePress = [...moves].reverse().find((m) => press && m.at <= press.at);
    const gap = press && lastMoveBeforePress ? press.at - lastMoveBeforePress.at : Infinity;
    const dist = press && lastMoveBeforePress
      ? Math.hypot(press.x - lastMoveBeforePress.x, press.y - lastMoveBeforePress.y)
      : Infinity;

    console.log(
      `#${i + 1} ${report.replay ? `回放 ${report.segmentId} (${report.subject})` : '兜底最小加加速度'}  ` +
        `距离 ${report.dist.toFixed(0)}px 用时 ${report.elapsed}ms 缩放 ${(report.scale ?? 1).toFixed(2)}\n` +
        `    事件 ${evs.length} 条：移动 ${moves.length} / 按下 ${press ? 1 : 0} / 抬起 ${release ? 1 : 0}  ` +
        `落点 (${press?.x.toFixed(1)}, ${press?.y.toFixed(1)})  按压 ${report.dwell}ms\n` +
        `    点击前最后一帧距点击 ${Number.isFinite(gap) ? gap.toFixed(0) + 'ms' : '—'}，` +
        `位移 ${Number.isFinite(dist) ? dist.toFixed(2) + 'px' : '—'}`,
    );
  }

  // 按检测器视角统计
  const moves = sent.filter((e) => e.type === 'mouseMoved');
  const intervals: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    // 只在同一次点击内算间隔
    if (moves[i]!.at - moves[i - 1]!.at < 500) intervals.push(moves[i]!.at - moves[i - 1]!.at);
  }

  const presses = sent.filter((e) => e.type === 'mousePressed');
  let teleports = 0;
  for (const p of presses) {
    const prev = moves.filter((m) => m.at < p.at).pop();
    if (!prev) {
      teleports++;
      continue;
    }
    // 点击前一帧离点击位置超过 5px，就算「瞬移点击」
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 5) teleports++;
  }

  console.log('\n=== 检测器视角 ===');
  console.log(`移动事件间隔 (ms)：${quantiles(intervals)}`);
  console.log(`点击总数 ${presses.length}，其中瞬移点击 ${teleports}（teleport_click_ratio ${(teleports / (presses.length || 1)).toFixed(2)}）`);

  const speeds: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    const dt = moves[i]!.at - moves[i - 1]!.at;
    if (dt <= 0 || dt > 500) continue;
    const d = Math.hypot(moves[i]!.x - moves[i - 1]!.x, moves[i]!.y - moves[i - 1]!.y);
    speeds.push((d / dt) * 1000);
  }
  console.log(`瞬时速度 (px/s)：${quantiles(speeds)}`);

  // 加加速度：检测器常看这个，突变说明是拼出来的
  const jerks: number[] = [];
  for (let i = 2; i < moves.length; i++) {
    const a = moves[i - 2]!;
    const b = moves[i - 1]!;
    const c = moves[i]!;
    const dt1 = b.at - a.at;
    const dt2 = c.at - b.at;
    if (dt1 <= 0 || dt2 <= 0 || dt1 > 200 || dt2 > 200) continue;
    const v1 = (b.x - a.x) / dt1;
    const v2 = (c.x - b.x) / dt2;
    jerks.push(Math.abs((v2 - v1) / ((dt1 + dt2) / 2)) * 1000);
  }
  console.log(`横向加速度变化率：${quantiles(jerks)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
