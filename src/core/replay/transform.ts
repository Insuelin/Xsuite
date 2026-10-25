// 几何变换。核心是相似变换：整体平移、旋转、各向同性缩放。
//
// 为什么必须各向同性：横竖分别缩放会把圆的轨迹变成椭圆，切向速度和法向
// 向心加速度的比例就变了，那个比例正是运动学检测器看的。
// 用复数乘一次就能同时完成旋转和缩放，而且因为候选段的距离被限制在 ±25%，
// 缩放系数不会离谱，最后一点能精确落在采样出来的目标点上，没有截断误差。

import type { Sample } from './types.ts';

export interface Point {
  x: number;
  y: number;
}

/** 旧值到新值的缩放容忍度。超过这个比例就该换一段更接近的，别硬拉。 */
export const SCALE_TOLERANCE = 0.25;

/**
 * 把一段轨迹贴到「从 from 走到 to」上。
 *
 * 用复数写就是 z' = from + (to - from) / u * z，其中 u 是该段原始的终点向量。
 * 除法同时完成缩放（模长比）和旋转（辐角差）。
 */
export function fitSegment(
  pts: Sample[],
  from: Point,
  to: Point,
  mirror: boolean,
): Sample[] {
  const last = pts[pts.length - 1]!;
  const ux = last.x;
  const uy = last.y;
  const uLen = Math.hypot(ux, uy);
  if (uLen < 1e-6) return pts.map((p) => ({ ...p }));

  // 镜像：沿首尾连线翻折，只改垂直于连线的分量
  let src = pts;
  if (mirror) {
    const ex = ux / uLen;
    const ey = uy / uLen;
    src = pts.map((p) => {
      const par = p.x * ex + p.y * ey;
      const perp = -p.x * ey + p.y * ex;
      return { x: par * ex - perp * ey, y: par * ey + perp * ex, t: p.t };
    });
  }

  const vx = to.x - from.x;
  const vy = to.y - from.y;
  const vLen = Math.hypot(vx, vy);
  if (vLen < 1e-6) return src.map((p) => ({ x: from.x, y: from.y, t: p.t }));

  // 复数除法：(vx + i·vy) / (ux + i·uy)
  const den = uLen * uLen;
  const re = (vx * ux + vy * uy) / den;
  const im = (vy * ux - vx * uy) / den;

  return src.map((p) => ({
    x: from.x + p.x * re - p.y * im,
    y: from.y + p.x * im + p.y * re,
    t: p.t,
  }));
}

/** 尺度比。调用方拿它判断这段是不是离要求太远。 */
export function scaleRatio(pts: Sample[], from: Point, to: Point): number {
  const last = pts[pts.length - 1]!;
  const u = Math.hypot(last.x, last.y);
  if (u < 1e-6) return Infinity;
  return Math.hypot(to.x - from.x, to.y - from.y) / u;
}

/** 汉宁窗，首尾正好是 0。给扰动加包络，保证端点是精确的。 */
function hann(i: number, n: number): number {
  if (n <= 1) return 0;
  const s = Math.sin((Math.PI * i) / (n - 1));
  return s * s;
}

/**
 * 加一层平滑扰动。直接用白噪声会让加速度序列出现尖刺，
 * 这里用几条正弦叠加，做出来是低频的，加速度依旧是连续的。
 */
export function addJitter(
  pts: Sample[],
  ampPx: number,
  rng: () => number,
): Sample[] {
  const n = pts.length;
  if (n < 3 || ampPx <= 0) return pts;

  // 三个不同频率的波，相位随机
  const waves = [0, 1, 2].map((k) => ({
    freq: (1.5 + k * 1.7) * (0.7 + rng() * 0.6),
    phase: rng() * Math.PI * 2,
    amp: (1 / (k + 1)) * (ampPx / 2),
  }));
  const wavesY = waves.map((w) => ({ ...w, phase: rng() * Math.PI * 2 }));

  return pts.map((p, i) => {
    const w = hann(i, n);
    const u = i / (n - 1);
    let dx = 0;
    let dy = 0;
    for (const s of waves) dx += s.amp * Math.sin(2 * Math.PI * s.freq * u + s.phase);
    for (const s of wavesY) dy += s.amp * Math.sin(2 * Math.PI * s.freq * u + s.phase);
    return { x: p.x + dx * w, y: p.y + dy * w, t: p.t };
  });
}

/**
 * Fitts 定律预测的耗时。缩放几何之后用它算时长该怎么跟着变。
 * a、b 取文献典型值，量级对了就行。
 */
export function fittsDuration(distPx: number, targetWidthPx = 20): number {
  return 75 + 150 * Math.log2(distPx / targetWidthPx + 1);
}

/**
 * 因为贴到新距离上而需要的时间修正系数。
 * 只缩放几何不改时长的话，会得到「同样的时间走更远」，峰值速度对不上。
 */
export function timeScaleFor(nativeDist: number, scaledDist: number, targetWidthPx = 20): number {
  const base = fittsDuration(Math.max(nativeDist, 1), targetWidthPx);
  const next = fittsDuration(Math.max(scaledDist, 1), targetWidthPx);
  return next / base;
}

/** 按系数拉伸时间轴 */
export function warpTime(pts: Sample[], factor: number): Sample[] {
  if (!Number.isFinite(factor) || factor <= 0) return pts;
  return pts.map((p) => ({ ...p, t: p.t * factor }));
}

/**
 * 在目标矩形里采一个落点。
 *
 * 真人不会每次都点正中心，落点在元素内大致是中心偏多的分布。
 * 用截断高斯：σ 取元素短边的四分之一，超出矩形就截回去。
 */
export function sampleLanding(rect: { x: number; y: number; width: number; height: number }, rng: () => number): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const sigma = Math.max(1, Math.min(rect.width, rect.height) / 4);

  // Box-Muller
  const gauss = () => {
    const u = Math.max(rng(), 1e-9);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  return {
    x: clamp(cx + gauss() * sigma, rect.x + 1, rect.x + rect.width - 1),
    y: clamp(cy + gauss() * sigma, rect.y + 1, rect.y + rect.height - 1),
  };
}

/** 把整段挪到绝对坐标上 */
export function translate(pts: Sample[], from: Point): Sample[] {
  return pts.map((p) => ({ ...p, x: p.x + from.x, y: p.y + from.y }));
}
