// 回放语料的数据结构。字段名和 scripts/build-segments.ts 写出来的一致。

export interface Sample {
  /** 相对起点的横向偏移 */
  x: number;
  /** 相对起点的纵向偏移 */
  y: number;
  /** 相对起始时刻的毫秒数 */
  t: number;
}

/** segments.jsonl 里的一行 */
export interface SegmentRecord {
  id: string;
  /** 来源数据集 */
  ds: string;
  /** 受试者 */
  subj: string;
  /** 首尾直线距离 */
  dist: number;
  /** 时长 ms */
  dur: number;
  /** 首尾方向，度 */
  dir: number;
  n: number;
  /** [dx, dy, t] 三元组 */
  pts: [number, number, number][];
  /** 落点相对起点的偏移 */
  click: [number, number];
  /** 按下到抬起，没有就是 null */
  dwell: number | null;
  eff: number;
  peakSpeed: number;
  peakPos: number;
}

/** subjects.json */
export interface SubjectIndex {
  dataset: string;
  features: string[];
  subjects: Record<
    string,
    { n: number; peakSpeed: number; eff: number; dur: number; peakPos: number; cluster: number }
  >;
  clusters: string[][];
}

/** 矩形区域，用视口 CSS 像素 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 已经用过的段。回放器只认这个接口，怎么存由调用方决定。 */
export interface UsedStore {
  has(id: string): boolean;
  add(id: string, meta?: { dataset?: string; subject?: string }): void;
}

/** 内存版，脚本里用 */
export function memoryStore(): UsedStore {
  const set = new Set<string>();
  return {
    has: (id) => set.has(id),
    add: (id) => set.add(id),
  };
}
