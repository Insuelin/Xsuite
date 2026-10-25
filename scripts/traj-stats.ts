// 轨迹语料体检：数一遍数据集的结构和形态，判断能不能当回放料。
//
// 用法：
//   node scripts/traj-stats.ts guidaeta
//   node scripts/traj-stats.ts sapimouse
//
// 输出 data/trajectories/<id>/stats.json，同时打印一份人看的摘要。
//
// 两个数据集的列不一样，下面用适配器抹平：事件统一成
//   { t: 毫秒, x, y, kind: 'move' | 'click' | 'other' }

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Kind = 'move' | 'click' | 'other';
type Ev = { t: number; x: number; y: number; kind: Kind };
type Pt = { t: number; x: number; y: number };

/**
 * 停顿阈值。真人在移动途中会停下思考，原始「上一个非移动事件到这次点击」的
 * 区间里会混进这些停顿，时长能拉到几十秒。按间隙切开，只留最后冲向目标的
 * 那一段，这才是能回放的一次移动。
 */
const GAP_MS = 300;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface Adapter {
  /** 找到这个数据集的所有事件文件 */
  files: (root: string) => string[];
  /** 一行 CSV 转成事件，转不了返回 null */
  parse: (p: string[]) => Ev | null;
}

const ADAPTERS: Record<string, Adapter> = {
  // GUIDÆTA：mouse_events/mm_<user>_<task>.csv，列见 observations.py 的 MouseEvent.DataField
  // session_id,type,timestamp,origin_x,origin_y,component,chapter,context_type,context_details
  // type: 0=MOVE 1=CLICK 2=SCROLL_UP 3=SCROLL_DOWN；timestamp 是 unix 秒
  guidaeta: {
    files: (root) => {
      const dir = join(root, 'mouse_events');
      return readdirSync(dir)
        .filter((f) => f.endsWith('.csv'))
        .map((f) => join(dir, f));
    },
    parse: (p) => {
      const type = Number(p[1]);
      const t = Number(p[2]) * 1000;
      const x = Number(p[3]);
      const y = Number(p[4]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { t, x, y, kind: type === 0 ? 'move' : type === 1 ? 'click' : 'other' };
    },
  },

  // SapiMouse：sapimouse/user<N>/session_*.csv
  // client timestamp,button,state,x,y；state 是 Move / Pressed / Released
  sapimouse: {
    files: (root) => {
      const base = join(root, 'sapimouse');
      const out: string[] = [];
      for (const user of readdirSync(base)) {
        const dir = join(base, user);
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) if (f.endsWith('.csv')) out.push(join(dir, f));
      }
      return out.sort();
    },
    parse: (p) => {
      const t = Number(p[0]);
      const state = p[2];
      const x = Number(p[3]);
      const y = Number(p[4]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const kind: Kind = state === 'Move' ? 'move' : state === 'Pressed' ? 'click' : 'other';
      return { t, x, y, kind };
    },
  },
};

function quantiles(xs: number[]): Record<string, number> {
  if (xs.length === 0) return {};
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    min: Math.round(s[0]!),
    p10: Math.round(at(0.1)),
    p50: Math.round(at(0.5)),
    p90: Math.round(at(0.9)),
    p99: Math.round(at(0.99)),
    max: Math.round(s[s.length - 1]!),
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const dist = (s: Pt[]) => {
  const a = s[0]!;
  const z = s[s.length - 1]!;
  return Math.hypot(z.x - a.x, z.y - a.y);
};
const dur = (s: Pt[]) => s[s.length - 1]!.t - s[0]!.t;

/** 每 45° 一档的方向直方图，判断要不要镜像补方向。 */
function directionBuckets(segs: Pt[][]): number[] {
  const b = new Array(8).fill(0);
  for (const s of segs) {
    const a = s[0]!;
    const z = s[s.length - 1]!;
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    if (dx === 0 && dy === 0) continue;
    // atan2 的 y 轴向下，转成数学方向后归到 8 档
    const deg = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    b[Math.round(deg / 45) % 8]! += 1;
  }
  const total = b.reduce((a, c) => a + c, 0) || 1;
  return b.map((v) => Math.round((v / total) * 1000) / 10);
}

function analyse(id: string) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`没有这个数据集的适配器：${id}`);

  const root = join('data', 'trajectories', id, 'raw');
  const files = adapter.files(root);

  const typeCount = new Map<string, number>();
  const intervals: number[] = [];
  const clickSegs: Pt[][] = [];
  const scrollSegs: Pt[][] = [];
  let rows = 0;

  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    let run: Pt[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const ev = adapter.parse(parseCsvLine(line));
      if (!ev) continue;
      rows++;
      typeCount.set(ev.kind, (typeCount.get(ev.kind) ?? 0) + 1);

      if (ev.kind === 'move') {
        const prev = run[run.length - 1];
        if (prev) {
          const dt = ev.t - prev.t;
          if (dt > 0 && dt < 500) intervals.push(dt);
          // 停顿太久就是另一次移动了，断开重来
          if (dt > GAP_MS) run = [];
        }
        run.push({ t: ev.t, x: ev.x, y: ev.y });
      } else {
        if (run.length >= 2) {
          if (ev.kind === 'click') clickSegs.push(run);
          else scrollSegs.push(run);
        }
        run = [];
      }
    }
    if (run.length >= 2) scrollSegs.push(run);
  }

  const clickDists = clickSegs.map(dist);
  const clickDurs = clickSegs.map(dur);
  const scrollDists = scrollSegs.map(dist);

  const band = (lo: number, hi: number) => clickDists.filter((d) => d >= lo && d < hi).length;
  const pct = (xs: number[], lo: number, hi: number) =>
    Math.round((xs.filter((d) => d >= lo && d < hi).length / (xs.length || 1)) * 1000) / 10;

  // 真正能直接用的：距离和时长都落在目标区间，点数够插值
  const usable = clickSegs.filter(
    (s) =>
      dist(s) >= 200 && dist(s) <= 1200 && dur(s) >= 300 && dur(s) <= 2000 && s.length >= 8,
  );

  const report = {
    dataset: id,
    files: files.length,
    rows,
    typeCount: Object.fromEntries(typeCount),
    segments: {
      click: clickSegs.length,
      scroll: scrollSegs.length,
      movePointsInClickSegs: clickSegs.reduce((a, s) => a + s.length, 0),
      avgPointsPerClickSeg: clickSegs.length
        ? Math.round(clickSegs.reduce((a, s) => a + s.length, 0) / clickSegs.length)
        : 0,
    },
    clickDistancePx: quantiles(clickDists),
    clickDurationMs: quantiles(clickDurs),
    scrollDistancePx: quantiles(scrollDists),
    moveIntervalMs: quantiles(intervals),
    clickDirectionPct: directionBuckets(clickSegs),
    distanceBands: {
      '0-100': band(0, 100),
      '100-200': band(100, 200),
      '200-400': band(200, 400),
      '400-800': band(400, 800),
      '800+': band(800, Infinity),
    },
    coverage: {
      'dist<100': pct(clickDists, 0, 100),
      'dist100-1000': pct(clickDists, 100, 1000),
      'dur<300': pct(clickDurs, 0, 300),
      'dur300-1500': pct(clickDurs, 300, 1500),
    },
    usableSegments: {
      count: usable.length,
      share: Math.round((usable.length / (clickSegs.length || 1)) * 1000) / 10,
      avgPoints: usable.length
        ? Math.round(usable.reduce((a, s) => a + s.length, 0) / usable.length)
        : 0,
    },
  };

  const out = join('data', 'trajectories', id, 'stats.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  return { report, out };
}

function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (ids.length === 0) ids.push('guidaeta', 'sapimouse');
  for (const id of ids) {
    const { report, out } = analyse(id);
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n写到 ${out}\n`);
  }
}

main();
