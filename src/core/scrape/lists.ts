// 列表抓取流水线：驱动页面滚动，被动收集 GraphQL 响应，直到游标到底或连续无新增。

import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { GraphQLInterceptor } from '../cdp/interceptor.ts';
import { parseTimeline, type ParsedUser } from '../cdp/parsers.ts';
import type { RelationKind } from '../../shared/domain.ts';

export interface ScrapeOptions {
  kind: RelationKind;
  url: string;
  /** 最多滚动多少次，防止死循环 */
  maxScrolls?: number;
  /** 连续多少次滚动没有新用户就停 */
  idleLimit?: number;
  /** 目标数量，达到就提前停（可选） */
  expectedTotal?: number;
  onProgress?: (info: { users: number; cursor: string | null; scrolls: number }) => void;
}

export interface ScrapeResult {
  users: ParsedUser[];
  bottomCursor: string | null;
  complete: boolean;
  scrolls: number;
  reason: 'cursor-end' | 'idle' | 'expected-reached' | 'max-scrolls' | 'aborted';
  /** 从请求 URL 的 variables 里拿到的列表所属账号 ID */
  sourceUserId: string | null;
}

/** 轮询等待条件成立。 */
async function waitFor(fn: () => boolean, timeoutMs: number, stepMs = 300): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

// 滚轮节奏：一组连续小步快速滚动，模拟"快速看完一屏"。
// 步与步之间 50-120ms，每步 300-600px，一组 3-8 步，组间停 0.8-2.5 秒。
const ROLL = {
  stepsMin: 2,
  stepsMax: 5,
  deltaMin: 400,
  deltaMax: 700,
  gapMin: 50,
  gapMax: 110,
  restMin: 900,
  restMax: 1800,
};

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function humanScroll(page: Page): Promise<void> {
  const steps = randInt(ROLL.stepsMin, ROLL.stepsMax);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randInt(ROLL.deltaMin, ROLL.deltaMax));
    await sleep(ROLL.gapMin + Math.random() * (ROLL.gapMax - ROLL.gapMin));
  }
  await sleep(ROLL.restMin + Math.random() * (ROLL.restMax - ROLL.restMin));
}

export async function scrapeRelationList(
  page: Page,
  interceptor: GraphQLInterceptor,
  opts: ScrapeOptions,
): Promise<ScrapeResult> {
  const users = new Map<string, ParsedUser>();
  let bottomCursor: string | null = null;
  let sourceUserId: string | null = null;

  const off = interceptor.on((r) => {
    if (r.kind !== opts.kind) return;

    // 从 URL 的 variables 里解析列表所属账号
    if (!sourceUserId) {
      try {
        const params = new URL(r.url).searchParams.get('variables');
        const vars = params ? JSON.parse(params) : null;
        if (vars?.userId) sourceUserId = String(vars.userId);
      } catch { /* ignore */ }
    }

    const parsed = parseTimeline(r.json);
    for (const u of parsed.users) users.set(u.id, u);
    if (parsed.bottomCursor) bottomCursor = parsed.bottomCursor;
    opts.onProgress?.({ users: users.size, cursor: bottomCursor, scrolls: 0 });
  });

  const maxScrolls = opts.maxScrolls ?? 200;
  const idleLimit = opts.idleLimit ?? 8;
  let scrolls = 0;
  let reason: ScrapeResult['reason'] = 'max-scrolls';

  try {
    await page.goto(opts.url, { waitUntil: 'commit', timeout: 60_000 });
    // 等第一页数据到达
    await waitFor(() => users.size > 0, 20_000);

    let idle = 0;
    for (let i = 0; i < maxScrolls; i++) {
      if (bottomCursor?.startsWith('0|')) {
        reason = 'cursor-end';
        break;
      }
      if (opts.expectedTotal && users.size >= opts.expectedTotal * 0.98) {
        reason = 'expected-reached';
        break;
      }

      const before = users.size;
      await humanScroll(page);
      scrolls++;

      if (users.size === before) idle++;
      else idle = 0;

      opts.onProgress?.({ users: users.size, cursor: bottomCursor, scrolls });

      if (idle >= idleLimit) {
        reason = 'idle';
        break;
      }
    }
  } finally {
    off();
  }

  return {
    users: [...users.values()],
    bottomCursor,
    complete: bottomCursor?.startsWith('0|') ?? false,
    scrolls,
    reason,
    sourceUserId,
  };
}
