// 页面操作。所有写操作都经过这里。
// dry-run 只走流程、高亮目标元素并截图，不触发点击。

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { SELECTORS, URLS } from './selectors.ts';

export interface ActionResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  screenshot?: string;
  /** 页面上实际找到的相关 testid，用于排查选择器失效 */
  foundTestIds?: string[];
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
 * 取关单个用户。
 * 先直跳固定 ID 主页（/i/user/{id}），不受对方改 handle 影响。
 */
export async function unfollowUser(
  page: Page,
  userId: string,
  opts: { dryRun: boolean; screenshotDir?: string },
): Promise<ActionResult> {
  const url = URLS.userPage(userId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1500);

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

  await unfollow.first().click({ timeout: 10_000 });
  await page.waitForTimeout(800);

  const confirm = page.locator(SELECTORS.confirmSheetConfirm);
  if ((await confirm.count()) > 0) {
    await confirm.first().click({ timeout: 10_000 });
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

  return { ok: true, dryRun: false };
}
