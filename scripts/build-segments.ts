// 把原始数据集切成「一次移动 + 一次点击」的整段，建回放用的索引。
//
// 用法：
//   node scripts/build-segments.ts              两个数据集都建
//   node scripts/build-segments.ts sapimouse   只建一个
//
// 产物：
//   data/trajectories/<id>/segments.jsonl   每行一段，点坐标相对起点
//   data/trajectories/<id>/subjects.json    受试者运动学特征 + 聚类
//
// 为什么要按受试者聚：同一个人手速、修正习惯、过冲幅度是稳定的。
// 同一个账号里一会儿抽到手快的、一会儿抽到手慢的，段内再真，会话级方差也会露馅。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Pt = { t: number; x: number; y: number };

/** 移动途中停顿超过这个值就当两次移动，断开 */
const GAP_MS = 300;

/** 收段的门槛：太短的段没法插值，太长的已经不是一次完整移动 */
const MIN_DIST = 60;
const MAX_DIST = 1600;
const MIN_DUR = 60;
const MAX_DUR = 2500;
const MIN_POINTS = 6;

interface Segment {
  id: string;
  ds: string;
  subj: string;
  /** 首尾直线距离 */
  dist: number;
  /** 时长 ms */
  dur: number;
  /** 首尾连线方向，度，数学坐标系（y 向上） */
  dir: number;
  n: number;
  /** 点序列 [dx, dy, t]，相对起点、相对起始时刻 */
  pts: [number, number, number][];
  /** 实际落点相对起点的偏移 —— 和最后一个移动点可能差几像素 */
  click: [number, number];
  /** 按下到抬起的毫秒数，只有 SapiMouse 有 */
  dwell: number | null;
  /** 路径效率 = 直线距离 / 实际路径长度，1 表示笔直 */
  eff: number;
  /** 峰值速度 px/s */
  peakSpeed: number;
  /** 峰值速度出现在行程的哪个位置，0~1 */
  peakPos: number;
}

interface Subjects {
  dataset: string;
  features: string[];
  subjects: Record<string, { n: number; peakSpeed: number; eff: number; dur: number; peakPos: number; cluster: number }>;
  clusters: string[][];
}

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

interface RawEv {
  t: number;
  x: number;
  y: number;
  kind: 'move' | 'click' | 'other';
  /** 换会话要断开 */
  session: string;
}

interface FileReader {
  files: string[];
  subjectOf: (file: string) => string;
  parse: (p: string[]) => RawEv | null;
}

function guidaetaReader(root: string): FileReader {
  const dir = join(root, 'mouse_events');
  return {
    files: readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => join(dir, f)),
    // mm_<user>_<task>.csv
    subjectOf: (f) => `u${(f.match(/mm_(\d+)_/) ?? [])[1] ?? '0'}`,
    parse: (p) => {
      const type = Number(p[1]);
      const t = Number(p[2]) * 1000;
      const x = Number(p[3]);
      const y = Number(p[4]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { t, x, y, kind: type === 0 ? 'move' : type === 1 ? 'click' : 'other', session: p[0] ?? '' };
    },
  };
}

function sapimouseReader(root: string): FileReader {
  const base = join(root, 'sapimouse');
  const files: string[] = [];
  for (const user of readdirSync(base)) {
    const d = join(base, user);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.csv')) files.push(join(d, f));
  }
  return {
    files: files.sort(),
    subjectOf: (f) => (f.match(/[\\/](user\d+)[\\/]/) ?? [])[1] ?? 'unknown',
    parse: (p) => {
      const t = Number(p[0]);
      const st = p[2];
      const x = Number(p[3]);
      const y = Number(p[4]);
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (st !== 'Move' && st !== 'Pressed' && st !== 'Released') return null;
      return {
        t,
        x,
        y,
        kind: st === 'Move' ? 'move' : st === 'Pressed' ? 'click' : 'other',
        session: '0',
      };
    },
  };
}

const READERS: Record<string, (root: string) => FileReader> = {
  guidaeta: guidaetaReader,
  sapimouse: sapimouseReader,
};

function segId(ds: string, file: string, subject: string, start: number, end: number): string {
  return (
    ds.slice(0, 2) +
    '-' +
    createHash('sha1').update(`${file}|${subject}|${start.toFixed(3)}|${end.toFixed(3)}`).digest('hex').slice(0, 10)
  );
}

function buildSegment(
  ds: string,
  file: string,
  subject: string,
  run: Pt[],
  click: Pt,
  dwell: number | null,
): Segment | null {
  const a = run[0]!;
  const z = run[run.length - 1]!;
  const dist = Math.hypot(z.x - a.x, z.y - a.y);
  const dur = z.t - a.t;
  if (dist < MIN_DIST || dist > MAX_DIST) return null;
  if (dur < MIN_DUR || dur > MAX_DUR) return null;
  if (run.length < MIN_POINTS) return null;

  // 路径长度和峰值速度顺手算掉，后面聚类要用
  let pathLen = 0;
  let peakSpeed = 0;
  let peakAt = 0;
  for (let i = 1; i < run.length; i++) {
    const p = run[i - 1]!;
    const c = run[i]!;
    const step = Math.hypot(c.x - p.x, c.y - p.y);
    pathLen += step;
    const dt = c.t - p.t;
    if (dt > 0) {
      const v = (step / dt) * 1000;
      if (v > peakSpeed) {
        peakSpeed = v;
        peakAt = (c.t - a.t) / dur;
      }
    }
  }
  if (pathLen <= 0) return null;

  const dirDeg = ((Math.atan2(-(z.y - a.y), z.x - a.x) * 180) / Math.PI + 360) % 360;

  return {
    id: segId(ds, file, subject, a.t, z.t),
    ds,
    subj: subject,
    dist: Math.round(dist * 10) / 10,
    dur: Math.round(dur),
    dir: Math.round(dirDeg * 10) / 10,
    n: run.length,
    pts: run.map((p) => [
      Math.round((p.x - a.x) * 10) / 10,
      Math.round((p.y - a.y) * 10) / 10,
      Math.round(p.t - a.t),
    ]),
    click: [Math.round((click.x - a.x) * 10) / 10, Math.round((click.y - a.y) * 10) / 10],
    dwell,
    eff: Math.round((dist / pathLen) * 1000) / 1000,
    peakSpeed: Math.round(peakSpeed),
    peakPos: Math.round(peakAt * 1000) / 1000,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** 固定种子的伪随机，保证每次聚类结果一样 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按运动学特征把受试者聚成若干簇。每簇内部手速和习惯接近，
 * 绑一簇就能兼顾「同一个人」和「有足够多段可用」。
 */
function clusterSubjects(
  names: string[],
  feats: number[][],
  k: number,
): number[] {
  const n = feats.length;
  const dim = feats[0]?.length ?? 0;
  if (n === 0) return [];
  k = Math.min(k, n);

  // 标准化，否则峰值速度会一家独大
  const mean = new Array(dim).fill(0);
  const sd = new Array(dim).fill(0);
  for (const f of feats) for (let d = 0; d < dim; d++) mean[d]! += f[d]! / n;
  for (const f of feats) for (let d = 0; d < dim; d++) sd[d]! += (f[d]! - mean[d]!) ** 2 / n;
  for (let d = 0; d < dim; d++) sd[d] = Math.sqrt(sd[d]!) || 1;
  const z = feats.map((f) => f.map((v, d) => (v - mean[d]!) / sd[d]!));

  const rnd = mulberry32(20261025);
  const centers: number[][] = [z[Math.floor(rnd() * n)]!];

  // k-means++：下一个中心按距离平方概率选，避免初始点挤在一起
  while (centers.length < k) {
    const d2 = z.map((p) => Math.min(...centers.map((c) => dist2(p, c))));
    const total = d2.reduce((a, b) => a + b, 0);
    let target = rnd() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i]!;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push(z[pick]!);
  }

  let assign = new Array(n).fill(-1);
  for (let iter = 0; iter < 50; iter++) {
    const next = z.map((p) => {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(p, centers[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    });
    if (next.every((v, i) => v === assign[i])) break;
    assign = next;
    for (let c = 0; c < centers.length; c++) {
      const members = z.filter((_, i) => assign[i] === c);
      if (members.length === 0) continue;
      centers[c] = Array.from({ length: dim }, (_, d) =>
        members.reduce((a, p) => a + p[d]!, 0) / members.length,
      );
    }
  }

  void names;
  return assign;
}

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return s;
}

function buildDataset(ds: string): void {
  const root = join('data', 'trajectories', ds, 'raw');
  const readerFn = READERS[ds];
  if (!readerFn) throw new Error(`没有这个数据集：${ds}`);
  const reader = readerFn(root);

  const segments: Segment[] = [];
  const bySubject = new Map<string, Segment[]>();

  for (const file of reader.files) {
    const subject = reader.subjectOf(file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let run: Pt[] = [];
    let session = '';
    let pressedAt: number | null = null;
    let lastPushed: Segment | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const ev = reader.parse(parseCsvLine(line));
      if (!ev) continue;

      if (ev.session !== session) {
        run = [];
        session = ev.session;
      }

      if (ev.kind === 'move') {
        const prev = run[run.length - 1];
        if (prev && ev.t - prev.t > GAP_MS) run = [];
        run.push({ t: ev.t, x: ev.x, y: ev.y });
        continue;
      }

      const before = run[run.length - 1];
      if (ev.kind === 'click' && run.length >= MIN_POINTS && before) {
        // 落点：优先用点击事件本身的坐标，没有就用最后一个移动点
        const seg = buildSegment(ds, file, subject, run, { t: ev.t, x: ev.x, y: ev.y }, null);
        if (seg) {
          segments.push(seg);
          const list = bySubject.get(subject) ?? [];
          list.push(seg);
          bySubject.set(subject, list);
          lastPushed = seg;
        }
      }
      if (ev.kind === 'click') pressedAt = ev.t;
      if (ev.kind === 'other' && pressedAt !== null) {
        // SapiMouse 的 Released 走这里：算按压驻留，补给刚按下的那一段
        if (lastPushed) lastPushed.dwell = Math.round(ev.t - pressedAt);
        pressedAt = null;
      }
      run = [];
    }
  }

  // 受试者特征
  const names = [...bySubject.keys()].sort();
  const feats = names.map((n) => {
    const list = bySubject.get(n)!;
    return [
      median(list.map((s) => s.peakSpeed)),
      median(list.map((s) => s.eff)),
      median(list.map((s) => s.dur)),
      median(list.map((s) => s.peakPos)),
    ];
  });
  const assign = clusterSubjects(names, feats, 8);

  const subjects: Subjects = {
    dataset: ds,
    features: ['peakSpeed', 'efficiency', 'durationMs', 'peakPos'],
    subjects: {},
    clusters: Array.from({ length: 8 }, () => [] as string[]),
  };
  names.forEach((n, i) => {
    const list = bySubject.get(n)!;
    subjects.subjects[n] = {
      n: list.length,
      peakSpeed: Math.round(feats[i]![0]!),
      eff: Math.round(feats[i]![1]! * 1000) / 1000,
      dur: Math.round(feats[i]![2]!),
      peakPos: Math.round(feats[i]![3]! * 1000) / 1000,
      cluster: assign[i]!,
    };
    subjects.clusters[assign[i]!]!.push(n);
  });
  subjects.clusters = subjects.clusters.filter((c) => c.length > 0);

  const outDir = join('data', 'trajectories', ds);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'segments.jsonl'), segments.map((s) => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(join(outDir, 'subjects.json'), JSON.stringify(subjects, null, 2));

  const bytes = segments.reduce((a, s) => a + JSON.stringify(s).length + 1, 0);
  console.log(`${ds}: ${segments.length} 段，${names.length} 个受试者，${(bytes / 1048576).toFixed(1)} MB`);
  console.log(
    `  每簇人数：${subjects.clusters.map((c) => c.length).join(' / ')}  ` +
      `每簇段数：${subjects.clusters.map((c) => c.reduce((a, n) => a + subjects.subjects[n]!.n, 0)).join(' / ')}`,
  );
}

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const id of ids.length > 0 ? ids : Object.keys(READERS)) buildDataset(id);
