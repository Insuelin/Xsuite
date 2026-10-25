// 回放模块对外的门面。上层只调 humanClick，语料加载、光标状态、
// 退回普通点击这些都收在这里。

import type { Locator, Page } from 'playwright-core';
import { config } from '../config.ts';
import { Corpus } from './corpus.ts';
import { HumanPointer, type ClickReport } from './pointer.ts';
import { memoryStore, type UsedStore } from './types.ts';

export type { ClickReport } from './pointer.ts';
export type { SegmentRecord, UsedStore } from './types.ts';
export { Corpus } from './corpus.ts';
export { HumanPointer, makeRng } from './pointer.ts';

let corpusCache: Corpus | null | undefined;

/** 语料只在第一次用到时读，之后常驻。没有索引文件就返回 null。 */
export function getCorpus(): Corpus | null {
  if (corpusCache !== undefined) return corpusCache;
  if (!config.replay.enabled) {
    corpusCache = null;
    return null;
  }
  const corpus = Corpus.load(config.replay.dir, config.replay.datasets);
  corpusCache = corpus.size > 0 ? corpus : null;
  if (!corpusCache) {
    console.warn(
      '[replay] 没找到轨迹索引，退回普通点击。跑一次 node scripts/build-segments.ts 生成。',
    );
  }
  return corpusCache;
}

/** 让测试或者脚本换一份语料 */
export function setCorpus(corpus: Corpus | null): void {
  corpusCache = corpus;
}

const pointers = new WeakMap<Page, HumanPointer>();
const fallbackStore = memoryStore();

/**
 * 同一个页面共用一个 cursor 状态，不然每次点击都以为光标在视口正中，
 * 第一帧就会「瞬移」。
 */
export function pointerFor(
  page: Page,
  opts: { used?: UsedStore; subjectPool?: Set<string>; rng?: () => number; subjectOffset?: number } = {},
): HumanPointer | null {
  const corpus = getCorpus();
  if (!corpus) return null;

  const existing = pointers.get(page);
  if (existing) return existing;

  const pointer = new HumanPointer(page, {
    corpus,
    used: opts.used ?? fallbackStore,
    ...selectSubjects(corpus, opts.subjectOffset),
    datasets: primaryDataset(corpus),
    jitterPx: config.replay.jitterPx,
    rng: opts.rng,
  });
  pointers.set(page, pointer);
  return pointer;
}

/**
 * 一个账号只用一份语料的手感。SapiMouse 的峰值速度中位 4810 px/s，
 * GUIDAETA 只有 2191，混着用等于一个人手速忽快忽慢。
 */
function primaryDataset(corpus: Corpus): string[] | undefined {
  const forced = process.env.XSUITE_REPLAY_DATASET;
  if (forced) return [forced];
  const ds = corpus.datasets.includes('sapimouse') ? 'sapimouse' : corpus.datasets[0];
  return ds ? [ds] : undefined;
}

/**
 * 当前该绑谁。
 *
 * 检测器的观测窗口不会跨周——最多是「这一次浏览器开着」到「这一天」。
 * 所以按天选一个人，一整天都用他的段；他不够了退到他所在的簇。
 *
 * 选的是段数最多的人，避免一天没做完就换人。
 */
export function selectSubjects(
  corpus: Corpus,
  offsetOverride?: number,
): { subjectPool?: Set<string>; fallbackPool?: Set<string> } {
  const fixed = process.env.XSUITE_REPLAY_SUBJECTS;
  if (fixed) return { subjectPool: new Set(fixed.split(',').map((s) => s.trim()).filter(Boolean)) };

  const ds = corpus.datasets.includes('sapimouse') ? 'sapimouse' : corpus.datasets[0];
  if (!ds) return {};

  const ranked = corpus.subjectsByCapacity(ds);
  if (ranked.length === 0) return {};

  // 取料最多的前若干个当候选，再按天在里头轮
  const choices = ranked.slice(0, Math.min(8, ranked.length));
  const days = config.replay.rotateDays;
  let idx = 0;
  if (days > 0) {
    const bucket = Math.floor(Date.now() / 86_400_000 / days);
    const offset = offsetOverride ?? config.replay.subjectOffset ?? 0;
    idx = (((bucket + offset) % choices.length) + choices.length) % choices.length;
  }

  const name = choices[idx]!.name;
  const cluster = corpus.clusterOf(ds, name);
  const groups = corpus.clusters[ds] ?? [];
  const clusterSet = cluster !== undefined ? new Set(groups[cluster] ?? []) : undefined;

  return { subjectPool: new Set([name]), fallbackPool: clusterSet };
}

/** 给上层用：现在绑的是哪一个，方便打日志和排查 */
export function currentSubjectPoolLabel(offsetOverride?: number): string | null {
  const corpus = getCorpus();
  if (!corpus) return null;
  const pools = selectSubjects(corpus, offsetOverride);
  const name = pools.subjectPool ? [...pools.subjectPool][0] : null;
  if (!name) return null;
  const fallback = pools.fallbackPool?.size ?? 0;
  const days = config.replay.rotateDays;
  const cadence = days > 0 ? `每 ${days} 天换` : '不换';
  return `${name}（退路 ${fallback} 人的簇，${cadence}）`;
}

export interface HumanClickResult extends ClickReport {
  /** true 表示最后是普通点击兜的底 */
  fellBack: boolean;
}

/**
 * 在元素上点一下。有语料就走真人回放，没有或者出错就退回 Playwright 原生点击，
 * 不让自动化工具本身成为失败的来源。
 */
export async function humanClick(
  page: Page,
  locator: Locator,
  opts: {
    used?: UsedStore;
    subjectPool?: Set<string>;
    rng?: () => number;
    dwellMs?: number;
    subjectOffset?: number;
  } = {},
): Promise<HumanClickResult> {
  const pointer = pointerFor(page, opts);
  if (!pointer) {
    await locator.click({ timeout: 10_000 });
    return { replay: false, fellBack: true, dist: 0, elapsed: 0 };
  }

  try {
    const report = await pointer.click(locator, { dwellMs: opts.dwellMs });
    return { ...report, fellBack: false };
  } catch (err) {
    console.warn('[replay] 回放失败，退回普通点击：', (err as Error).message);
    await locator.click({ timeout: 10_000 });
    return { replay: false, fellBack: true, dist: 0, elapsed: 0 };
  }
}

/** 换页之后光标位置要重新建立 */
export function forgetPointer(page: Page): void {
  void pointers.get(page)?.dispose();
  pointers.delete(page);
}
