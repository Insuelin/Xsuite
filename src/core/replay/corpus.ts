// 语料索引：按需要走的距离挑一段真人的移动。
//
// 挑选原则是「找现成的，别改造」。候选必须和需求距离相差不超过 25%，
// 这样贴上去之后缩放系数不会离谱，速度曲线还是原来那条。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SegmentRecord, SubjectIndex, UsedStore } from './types.ts';
import { SCALE_TOLERANCE } from './transform.ts';

export interface PickRequest {
  /** 这次要走多远 */
  dist: number;
  /** 已经用过的段，不要再挑 */
  used: UsedStore;
  /** 优先从这个受试者集合里挑，通常是一个运动学簇 */
  subjectPool?: Set<string>;
  /** 只在这些数据集里挑。混数据集会把不同手速的人掺进同一个账号。 */
  datasets?: string[];
  rng: () => number;
}

export interface PickResult {
  segment: SegmentRecord;
  /** 实际缩放系数，用来修正时长 */
  scale: number;
}

export class Corpus {
  readonly segments: SegmentRecord[];
  private readonly byId: Map<string, SegmentRecord>;
  /** 数据集 → 簇列表 */
  readonly clusters: Record<string, string[][]>;
  /** 数据集 → 受试者 → 簇号 */
  readonly subjectCluster: Record<string, Record<string, number>>;
  readonly datasets: string[];

  private constructor(
    segments: SegmentRecord[],
    clusters: Record<string, string[][]>,
    subjectCluster: Record<string, Record<string, number>>,
    datasets: string[],
  ) {
    this.segments = segments;
    this.byId = new Map(segments.map((s) => [s.id, s]));
    this.clusters = clusters;
    this.subjectCluster = subjectCluster;
    this.datasets = datasets;
  }

  /** 从 data/trajectories/<id>/ 读索引。缺哪个数据集就跳过哪个。 */
  static load(root: string, datasetIds: string[]): Corpus {
    const segments: SegmentRecord[] = [];
    const clusters: Record<string, string[][]> = {};
    const subjectCluster: Record<string, Record<string, number>> = {};
    const datasets: string[] = [];

    for (const id of datasetIds) {
      const dir = join(root, id);
      const segFile = join(dir, 'segments.jsonl');
      if (!existsSync(segFile)) continue;
      datasets.push(id);

      for (const line of readFileSync(segFile, 'utf8').split('\n')) {
        if (!line) continue;
        segments.push(JSON.parse(line) as SegmentRecord);
      }

      const subjFile = join(dir, 'subjects.json');
      if (existsSync(subjFile)) {
        const idx = JSON.parse(readFileSync(subjFile, 'utf8')) as SubjectIndex;
        clusters[id] = idx.clusters;
        subjectCluster[id] = Object.fromEntries(
          Object.entries(idx.subjects).map(([name, v]) => [name, v.cluster]),
        );
      }
    }

    return new Corpus(segments, clusters, subjectCluster, datasets);
  }

  get size(): number {
    return this.segments.length;
  }

  /**
   * 挑一段。返回 null 表示候选池空了 —— 调用方应该退回到普通点击，
   * 或者把用过的记录清掉。
   */
  pick(req: PickRequest): PickResult | null {
    const lo = 1 - SCALE_TOLERANCE;
    const hi = 1 + SCALE_TOLERANCE;

    const inRange: SegmentRecord[] = [];
    for (const s of this.segments) {
      if (s.dist <= 0) continue;
      if (req.datasets && req.datasets.length > 0 && !req.datasets.includes(s.ds)) continue;
      // 按缩放系数筛，不按距离差筛：要保证的是「这段不用被拉太狠」
      const scale = req.dist / s.dist;
      if (scale < lo || scale > hi) continue;
      if (req.used.has(s.id)) continue;
      inRange.push(s);
    }
    if (inRange.length === 0) return null;

    // 同一个簇里的人手速和习惯接近，优先用他们的段
    let pool = inRange;
    if (req.subjectPool && req.subjectPool.size > 0) {
      const preferred = inRange.filter((s) => req.subjectPool!.has(s.subj));
      if (preferred.length > 0) pool = preferred;
    }

    const segment = pool[Math.floor(req.rng() * pool.length)]!;
    return { segment, scale: req.dist / segment.dist };
  }

  /**
   * 给一个账号绑一簇受试者。挑段数最多的那簇，保证有足够料。
   * dataset 为 null 时跨数据集合并。
   */
  clusterPool(dataset: string | null, clusterIndex?: number): Set<string> {
    const out = new Set<string>();
    const sources = dataset ? [dataset] : Object.keys(this.clusters);
    for (const ds of sources) {
      const groups = this.clusters[ds];
      if (!groups || groups.length === 0) continue;
      const idx =
        clusterIndex !== undefined && clusterIndex < groups.length
          ? clusterIndex
          : this.largestCluster(ds);
      for (const s of groups[idx] ?? []) out.add(s);
    }
    return out;
  }

  private largestCluster(dataset: string): number {
    const groups = this.clusters[dataset] ?? [];
    let best = 0;
    let bestN = -1;
    groups.forEach((g, i) => {
      if (g.length > bestN) {
        bestN = g.length;
        best = i;
      }
    });
    return best;
  }

  /** 某个受试者名属于哪个簇 */
  clusterOf(dataset: string, subject: string): number | undefined {
    return this.subjectCluster[dataset]?.[subject];
  }

  /**
   * 按可用段数从多到少排受试者。
   *
   * 一个会话只绑一个人，所以得挑料最多的那些，
   * 免得一天还没过完就换人，那反而成了破绽。
   */
  subjectsByCapacity(dataset: string): { name: string; segments: number }[] {
    const out: { name: string; segments: number }[] = [];
    for (const s of this.segments) {
      if (s.ds !== dataset) continue;
      const hit = out.find((o) => o.name === s.subj);
      if (hit) hit.segments++;
      else out.push({ name: s.subj, segments: 1 });
    }
    return out.sort((a, b) => b.segments - a.segments);
  }
}
