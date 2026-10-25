// 页面操作。所有写操作都经过这里。
// dry-run 只走流程、高亮目标元素并截图，不触发点击。

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { humanClick } from '../replay/index.ts';
import type { UsedStore } from '../replay/types.ts';
import { SELECTORS, URLS } from './selectors.ts';

export interface ActionResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  screenshot?: string;
  /** 页面上实际找到的相关 testid，用于排查选择器失效 */
  foundTestIds?: string[];
  /** 点击是不是走的真人轨迹回放 */
  replay?: boolean;
}

export interface ActionOptions {
  dryRun: boolean;
  screenshotDir?: string;
  /** 回放用过的段记在这里，传了才不会重复抽同一条 */
  used?: UsedStore;
  /** 账号相位，让不同号的手感轮换错开 */
  subjectOffset?: number;
}

async function collectTestIds(page: Page, keyword: string): Promise<string[]> {
  try {
    return await page.evaluate((kw: string) => {
      const set = new Set<string>();
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid') || '';
        if (kw === '' || id.includes(kw)) set.add(id);
      });
      return [...set].slice(0, 40);
    }, keyword);
  } catch {
    return [];
  }
}

async function shot(page: Page, dir: string | undefined, name: string): Promise<string | undefined> {
  if (!dir) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}


/**
 * 等主页上的关注/取关按钮出现。
 *
 * X 是单页应用，goto 的 domcontentloaded 之后还要等组件挂载，
 * 固定 sleep 会时快时慢——之前就因为 1500ms 不够，连按钮都没找到就放弃了。
 */
async function waitForProfileButton(page: Page, userId: string, timeoutMs = 20_000): Promise<void> {
  const both = `${SELECTORS.followButton(userId)}, ${SELECTORS.unfollowButton(userId)}`;
  await page.waitForSelector(both, { timeout: timeoutMs }).catch(() => {});
}

/**
 * 关注单个用户。直跳固定 ID 主页，不受对方改 handle 影响。
 * 关注一般没有确认弹窗，但个别账号会弹，兜底点掉。
 */
export async function followUser(
  page: Page,
  userId: string,
  opts: ActionOptions,
): Promise<ActionResult> {
  const url = URLS.userPage(userId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForProfileButton(page, userId);

  const followSel = SELECTORS.followButton(userId);
  const unfollowSel = SELECTORS.unfollowButton(userId);

  const follow = page.locator(followSel);
  const hasFollow = (await follow.count()) > 0;
  const hasUnfollow = (await page.locator(unfollowSel).count()) > 0;

  if (!hasFollow) {
    const screenshot = await shot(page, opts.screenshotDir, `follow-miss-${userId}`);
    if (hasUnfollow) {
      return { ok: true, dryRun: opts.dryRun, error: '当前已是关注状态，无需关注', screenshot };
    }
    return {
      ok: false,
      dryRun: opts.dryRun,
      error: `找不到关注按钮 ${followSel}，也找不到取关按钮 ${unfollowSel}`,
      screenshot,
      foundTestIds: await collectTestIds(page, '-'),
    };
  }

  await follow.first().highlight().catch(() => {});

  if (opts.dryRun) {
    const screenshot = await shot(page, opts.screenshotDir, `follow-dry-${userId}`);
    return { ok: true, dryRun: true, screenshot };
  }

  const followClick = await humanClick(page, follow.first(), { used: opts.used, subjectOffset: opts.subjectOffset });
  await page.waitForTimeout(800);

  const confirm = page.locator(SELECTORS.confirmSheetConfirm);
  if ((await confirm.count()) > 0) {
    await humanClick(page, confirm.first(), { used: opts.used, subjectOffset: opts.subjectOffset });
    await page.waitForTimeout(800);
  }

  // 验证：按钮应该变成取关
  if ((await page.locator(followSel).count()) > 0) {
    return {
      ok: false,
      dryRun: false,
      error: '点击后按钮仍是关注状态，可能未生效',
      screenshot: await shot(page, opts.screenshotDir, `follow-fail-${userId}`),
    };
  }

  return { ok: true, dryRun: false, replay: followClick.replay };
}

/**
 * 取关单个用户。
 * 先直跳固定 ID 主页（/i/user/{id}），不受对方改 handle 影响。
 */
export async function unfollowUser(
  page: Page,
  userId: string,
  opts: ActionOptions,
): Promise<ActionResult> {
  const url = URLS.userPage(userId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForProfileButton(page, userId);

  const unfollowSel = SELECTORS.unfollowButton(userId);
  const followSel = SELECTORS.followButton(userId);

  const unfollow = page.locator(unfollowSel);
  const follow = page.locator(followSel);

  const hasUnfollow = (await unfollow.count()) > 0;
  const hasFollow = (await follow.count()) > 0;

  if (!hasUnfollow) {
    const screenshot = await shot(page, opts.screenshotDir, `unfollow-miss-${userId}`);
    if (hasFollow) {
      return { ok: true, dryRun: opts.dryRun, error: '当前未关注该用户，无需取关', screenshot };
    }
    return {
      ok: false,
      dryRun: opts.dryRun,
      error: `找不到取关按钮 ${unfollowSel}，也找不到关注按钮 ${followSel}`,
      screenshot,
      foundTestIds: await collectTestIds(page, '-'),
    };
  }

  // 高亮，方便 dry-run 时肉眼确认
  await unfollow.first().highlight().catch(() => {});

  if (opts.dryRun) {
    const screenshot = await shot(page, opts.screenshotDir, `unfollow-dry-${userId}`);
    return { ok: true, dryRun: true, screenshot };
  }

  const unfollowClick = await humanClick(page, unfollow.first(), { used: opts.used, subjectOffset: opts.subjectOffset });
  await page.waitForTimeout(800);

  const confirm = page.locator(SELECTORS.confirmSheetConfirm);
  if ((await confirm.count()) > 0) {
    await humanClick(page, confirm.first(), { used: opts.used, subjectOffset: opts.subjectOffset });
    await page.waitForTimeout(800);
  }

  // 验证：按钮应该变成 follow
  const stillUnfollow = (await page.locator(unfollowSel).count()) > 0;
  if (stillUnfollow) {
    return {
      ok: false,
      dryRun: false,
      error: '点击后按钮仍是取关状态，可能未生效',
      screenshot: await shot(page, opts.screenshotDir, `unfollow-fail-${userId}`),
    };
  }

  return { ok: true, dryRun: false, replay: unfollowClick.replay };
}
