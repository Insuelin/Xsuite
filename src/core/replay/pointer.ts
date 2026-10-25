// 回放器本体：把语料里的一段真轨迹通过 CDP 发出去。
//
// 几个刻意的设计：
//   · 时间用绝对时钟排期（T0 + t_i），不用固定 sleep，避免 CDP 往返耗时累积
//   · 落后计划太多就丢帧，保证总时长不被拖长
//   · 点击拆成 down / 停一会儿 / up，按压期间允许 1px 以内的滑移
//   · 光标位置自己记，因为 CDP 没有读取当前光标的接口

import type { CDPSession, Locator, Page } from 'playwright-core';
import type { Sample, UsedStore } from './types.ts';
import type { Corpus } from './corpus.ts';
import {
  addJitter,
  fittsDuration,
  fitSegment,
  sampleLanding,
  scaleRatio,
  timeScaleFor,
  warpTime,
} from './transform.ts';

export interface PointerOptions {
  corpus: Corpus;
  used: UsedStore;
  /** 首选受试者集合，通常就是一个人 */
  subjectPool?: Set<string>;
  /** 首选池用完之后退到哪，通常是他所在的那个簇 */
  fallbackPool?: Set<string>;
  /** 只用这些数据集的段。同一个账号不要混手速差一倍的两个人。 */
  datasets?: string[];
  /** 扰动的最大幅度，像素 */
  jitterPx?: number;
  /** 随机源，测试时可以固定 */
  rng?: () => number;
  /** 初始光标位置，默认视口正中 */
  start?: { x: number; y: number };
}

export interface ClickReport {
  /** 用的是真人回放还是退回普通点击 */
  replay: boolean;
  segmentId?: string;
  subject?: string;
  /** 实际走完的直线距离 */
  dist: number;
  /** 实际用时，毫秒 */
  elapsed: number;
  /** 缩放系数，看是不是拉得太狠 */
  scale?: number;
  /** 按压驻留 */
  dwell?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** 固定种子的伪随机 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 最小加加速度路径。只在走不了语料的时候用（距离太短、或者语料里没合适的）。
 * 这条曲线位置、速度、加速度三阶连续，两端加速度为零，是人的手在动的样子。
 */
function minJerkPath(from: { x: number; y: number }, to: { x: number; y: number }): Sample[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const dur = fittsDuration(Math.max(dist, 1));
  const steps = Math.max(6, Math.min(60, Math.round(dur / 17)));
  const out: Sample[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const k = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
    out.push({
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      t: dur * s,
    });
  }
  return out;
}

export class HumanPointer {
  private readonly page: Page;
  private readonly corpus: Corpus;
  private readonly used: UsedStore;
  private readonly subjectPool?: Set<string>;
  private readonly fallbackPool?: Set<string>;
  private readonly datasets?: string[];
  private readonly jitterPx: number;
  private readonly rng: () => number;

  private session: CDPSession | null = null;
  private pos: { x: number; y: number } | null;
  private park: { x: number; y: number } | null;

  constructor(page: Page, opts: PointerOptions) {
    this.page = page;
    this.corpus = opts.corpus;
    this.used = opts.used;
    this.subjectPool = opts.subjectPool;
    this.fallbackPool = opts.fallbackPool;
    this.datasets = opts.datasets;
    this.jitterPx = opts.jitterPx ?? 1.2;
    this.rng = opts.rng ?? makeRng(Date.now() >>> 0);
    this.pos = opts.start ?? null;
    this.park = opts.start ?? null;
  }

  private async cdp(): Promise<CDPSession> {
    if (!this.session) this.session = await this.page.context().newCDPSession(this.page);
    return this.session;
  }

  private async viewport(): Promise<{ w: number; h: number }> {
    const size = await this.page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    return size;
  }

  /** 光标在哪。不知道就从视口正中开始，反正第一次移动之后就准了。 */
  private async cursor(): Promise<{ x: number; y: number }> {
    if (this.pos) return this.pos;
    const vp = await this.viewport();
    this.pos = this.park ?? { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
    return this.pos;
  }

  /**
   * 按绝对时间表把点发出去。落后超过 skipMs 的中间帧直接丢，
   * 保证总时长和事件密度跟原轨迹对得上。
   */
  private async play(pts: Sample[], timeScale: number): Promise<void> {
    const session = await this.cdp();
    const t0 = performance.now();
    const last = pts.length - 1;
    // 两帧之间至少隔这么久。CDP 往返偶尔会拖慢一拍，如果不设下限，
    // 下一帧会因为「已经过期」立刻发出去，做出 4ms 这种人类不可能有的间隔。
    const minGap = 8;
    let lastSent = -Infinity;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      let due = t0 + p.t * timeScale;
      if (due < lastSent + minGap) due = lastSent + minGap;

      const wait = due - performance.now();
      if (wait > 0) {
        await sleep(wait);
      } else if (-wait > 60 && i !== last) {
        // 已经落后太多，这一帧没有意义了
        continue;
      }

      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: p.x,
        y: p.y,
        button: 'none',
        buttons: 0,
        clickCount: 0,
      });
      lastSent = performance.now();
    }

    const end = pts[last]!;
    this.pos = { x: end.x, y: end.y };
  }

  /** 从当前位置走到 target。优先用真人语料。 */
  async moveTo(target: { x: number; y: number }): Promise<ClickReport> {
    const from = await this.cursor();
    const dist = Math.hypot(target.x - from.x, target.y - from.y);
    const startedAt = performance.now();

    /*
     * 梯队：先只用这一个人的段；他不够了退到他所在的簇；再不够才放开整个数据集。
     * 每退一级，个体一致性就差一点，但都比退回合成轨迹强。
     */
    const base = { dist, used: this.used, datasets: this.datasets, rng: this.rng };
    let picked = this.corpus.pick({ ...base, subjectPool: this.subjectPool });
    if (!picked && this.fallbackPool) picked = this.corpus.pick({ ...base, subjectPool: this.fallbackPool });
    if (!picked) picked = this.corpus.pick(base);

    let pts: Sample[];
    let scale: number | undefined;
    let segmentId: string | undefined;
    let subject: string | undefined;
    let timeScale = 1;

    if (picked && Math.abs(picked.scale - 1) <= 0.25) {
      const mirror = this.rng() < 0.5;
      const fitted = fitSegment(
        picked.segment.pts.map(([x, y, t]) => ({ x, y, t })),
        from,
        target,
        mirror,
      );
      const ratio = scaleRatio(
        picked.segment.pts.map(([x, y, t]) => ({ x, y, t })),
        from,
        target,
      );
      pts = addJitter(fitted, this.jitterPx, this.rng);
      timeScale = timeScaleFor(picked.segment.dist, picked.segment.dist * ratio);
      segmentId = picked.segment.id;
      subject = picked.segment.subj;
      scale = picked.scale;
      this.used.add(picked.segment.id, { dataset: picked.segment.ds, subject: picked.segment.subj });
    } else {
      pts = addJitter(minJerkPath(from, target), this.jitterPx, this.rng);
    }

    // 扰动用汉宁窗包络，端点严格不动，所以最后一点就是 target
    pts[pts.length - 1] = { x: target.x, y: target.y, t: pts[pts.length - 1]!.t };

    await this.play(pts, timeScale);

    return {
      replay: Boolean(segmentId),
      segmentId,
      subject,
      dist,
      elapsed: Math.round(performance.now() - startedAt),
      scale,
    };
  }

  /**
   * 在元素上点一下。走的是完整流程：移动 → 按下 → 驻留 → 抬起。
   * 不调 locator.click()，那条路径没有移动历史。
   */
  async click(
    locator: Locator,
    opts: { dwellMs?: number } = {},
  ): Promise<ClickReport> {
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});

    const box = await locator.boundingBox();
    if (!box) throw new Error('元素没有可点击的尺寸');

    // 落点不能老是正中，元素内按截断高斯采样
    const landing = sampleLanding(box, this.rng);
    const report = await this.moveTo(landing);

    /*
     * 手到位之后不会立刻按下去，SapiMouse 实测这段停顿 n=26,807，
     * p10/p50/p90 = 5 / 54 / 205 ms，尾部很长。
     * 每次都做成 0ms 是最明显的机械特征之一。
     */
    const settle = opts.dwellMs === undefined ? this.sampleSettle() : 0;
    if (settle > 0) await sleep(settle);

    const dwell = opts.dwellMs ?? this.sampleDwell();
    await this.press(landing, dwell);

    this.pos = landing;
    return { ...report, dwell };
  }

  /** 末帧到按下之间的停顿，对数正态，按实测分布拟合 */
  private sampleSettle(): number {
    const u = Math.max(this.rng(), 1e-9);
    const v = this.rng();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const ms = Math.exp(3.99 + 1.04 * normal);
    return Math.round(Math.min(600, Math.max(0, ms)));
  }

  /** 按下、停留、抬起。停留期间偶尔有 1px 以内的滑移。 */
  private async press(at: { x: number; y: number }, dwellMs: number): Promise<void> {
    const session = await this.cdp();

    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });

    // 一半概率手会微微动一下，幅度不超过 1px
    if (dwellMs > 60 && this.rng() < 0.5) {
      await sleep(dwellMs * 0.4);
      const slip = {
        x: at.x + (this.rng() - 0.5) * 2,
        y: at.y + (this.rng() - 0.5) * 2,
      };
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: slip.x,
        y: slip.y,
        button: 'left',
        buttons: 1,
        clickCount: 0,
      });
      await sleep(dwellMs * 0.6);
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: slip.x,
        y: slip.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      return;
    }

    await sleep(dwellMs);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  /**
   * 按压驻留时长。SapiMouse 实测 p10/p50/p90 = 56/86/485 ms，
   * 分布是双峰的，多数人 60~120，少数人按得久。
   */
  private sampleDwell(): number {
    const r = this.rng();
    if (r < 0.7) return Math.round(60 + this.rng() * 60);
    return Math.round(180 + this.rng() * 420);
  }

  /** 关掉 CDP 会话。注意这只关会话，不动用户浏览器。 */
  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.detach().catch(() => {});
      this.session = null;
    }
  }
}
