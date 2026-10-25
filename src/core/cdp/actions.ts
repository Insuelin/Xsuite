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

// ---------------------------------------------------------------- 菜单类操作
//
// mute / block 都不在主页上，藏在右上角「更多」展开的菜单里。
//
// 坑：菜单项的 data-testid 前后不变（一直是 mute / block），
// 只有文字会从「隐藏」翻成「取消隐藏」。所以判断状态只能读文字。
// 文字是随界面语言走的，这里收集中英两种，认不出来就靠「点完文字有没有变」来判断。

export type MenuOp = 'mute' | 'unmute' | 'block' | 'unblock';

interface MenuSpec {
  /** 菜单项的选择器，两种状态共用同一个 */
  selector: string;
  /** 已经处于目标状态时，菜单项显示的文字 */
  done: string[];
  /** 还没做时显示的文字 */
  todo: string[];
  verb: string;
}

const MENU_SPEC: Record<MenuOp, MenuSpec> = {
  mute: {
    selector: SELECTORS.menuMute,
    done: ['取消隐藏', 'Unmute'],
    todo: ['隐藏', 'Mute'],
    verb: '隐藏',
  },
  unmute: {
    selector: SELECTORS.menuMute,
    done: ['隐藏', 'Mute'],
    todo: ['取消隐藏', 'Unmute'],
    verb: '取消隐藏',
  },
  block: {
    selector: SELECTORS.menuBlock,
    done: ['取消屏蔽', 'Unblock'],
    todo: ['屏蔽', 'Block'],
    verb: '屏蔽',
  },
  unblock: {
    selector: SELECTORS.menuBlock,
    done: ['屏蔽', 'Block'],
    todo: ['取消屏蔽', 'Unblock'],
    verb: '取消屏蔽',
  },
};

const MENU_ANY_ITEM = `${SELECTORS.menuMute}, ${SELECTORS.menuBlock}, [role="menuitem"]`;

/**
 * 打开「更多」菜单。菜单没弹出来就是 false。
 *
 * 刚进主页时按钮已经在了但 React 还没挂完事件，点一次可能没反应，
 * 所以点两轮；每轮都等菜单项真的出现才算成功。
 */
async function openUserMenu(page: Page, userId: string): Promise<boolean> {
  await waitForProfileButton(page, userId);
  await page.waitForSelector(SELECTORS.userActionsMenu, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(700);

  const more = page.locator(SELECTORS.userActionsMenu);
  if ((await more.count()) === 0) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await page.keyboard.press('Escape').catch(() => {});
    await more.first().click({ timeout: 10_000 }).catch(() => {});
    const appeared = await page
      .waitForSelector(MENU_ANY_ITEM, { timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

/** 读菜单项的文字。读不到就是空串。 */
async function readMenuLabel(page: Page, selector: string): Promise<string> {
  const el = page.locator(selector);
  if ((await el.count()) === 0) return '';
  return ((await el.first().textContent()) ?? '').trim();
}

function matchLabel(text: string, labels: string[]): boolean {
  return labels.some((l) => text.startsWith(l));
}

export async function muteUser(page: Page, userId: string, opts: ActionOptions): Promise<ActionResult> {
  return menuAction(page, userId, 'mute', opts);
}

export async function unmuteUser(page: Page, userId: string, opts: ActionOptions): Promise<ActionResult> {
  return menuAction(page, userId, 'unmute', opts);
}

export async function blockUser(page: Page, userId: string, opts: ActionOptions): Promise<ActionResult> {
  return menuAction(page, userId, 'block', opts);
}

export async function unblockUser(page: Page, userId: string, opts: ActionOptions): Promise<ActionResult> {
  return menuAction(page, userId, 'unblock', opts);
}

/**
 * 主页上的「你已隐藏该账号的帖子」提示。
 *
 * 比读菜单文字可靠得多：菜单项在操作后可能还是缓存的旧状态，
 * 而这条提示是页面根据自己的真实数据渲染的。
 */
const MUTED_NOTICE = ['你已隐藏该账号的帖子', 'You have muted this account'];

async function mutedNoticeVisible(page: Page): Promise<boolean> {
  for (const text of MUTED_NOTICE) {
    if ((await page.getByText(text).count()) > 0) return true;
  }
  return false;
}

async function menuAction(
  page: Page,
  userId: string,
  op: MenuOp,
  opts: ActionOptions,
): Promise<ActionResult> {
  const spec = MENU_SPEC[op];
  const url = URLS.userPage(userId);
  // 隐藏类操作用主页提示判断状态，屏蔽类只能看菜单项文字
  const byNotice = op === 'mute' || op === 'unmute';

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForProfileButton(page, userId);
  await page.waitForTimeout(600);

  if (byNotice) {
    const muted = await mutedNoticeVisible(page);
    const wantMuted = op === 'mute';
    if (muted === wantMuted) {
      return { ok: true, dryRun: opts.dryRun, error: `当前已是「${spec.verb}」状态，无需操作` };
    }
  }

  if (!(await openUserMenu(page, userId))) {
    return {
      ok: false,
      dryRun: opts.dryRun,
      error: '打不开「更多」菜单，页面结构可能变了',
      screenshot: await shot(page, opts.screenshotDir, `${op}-nomenu-${userId}`),
    };
  }

  if ((await page.locator(spec.selector).count()) === 0) {
    await closeMenu(page);
    return {
      ok: false,
      dryRun: opts.dryRun,
      error: `菜单里没有 ${spec.selector}`,
      screenshot: await shot(page, opts.screenshotDir, `${op}-miss-${userId}`),
      foundTestIds: await collectTestIds(page, ''),
    };
  }

  const before = await readMenuLabel(page, spec.selector);

  // 屏蔽类没有别的可靠信号，只能靠菜单文字判断是不是已经做过了
  if (!byNotice && matchLabel(before, spec.done)) {
    await closeMenu(page);
    return { ok: true, dryRun: opts.dryRun, error: `当前已是「${spec.verb}」状态，无需操作` };
  }

  const item = page.locator(spec.selector).first();
  await item.highlight().catch(() => {});

  if (opts.dryRun) {
    const screenshot = await shot(page, opts.screenshotDir, `${op}-dry-${userId}`);
    await closeMenu(page);
    return { ok: true, dryRun: true, screenshot };
  }

  await humanClick(page, item, { used: opts.used, subjectOffset: opts.subjectOffset });
  await page.waitForTimeout(700);

  // 屏蔽一定会弹确认框；隐藏有时候不弹
  const confirm = page.locator(SELECTORS.confirmSheetConfirm);
  if ((await confirm.count()) > 0) {
    await humanClick(page, confirm.first(), { used: opts.used, subjectOffset: opts.subjectOffset });
    await page.waitForTimeout(900);
  }

  // 验证：重新加载，用各自的判定方式复查
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForProfileButton(page, userId);
  await page.waitForTimeout(800);

  if (byNotice) {
    const muted = await mutedNoticeVisible(page);
    const wantMuted = op === 'mute';
    if (muted === wantMuted) return { ok: true, dryRun: false };
    return {
      ok: false,
      dryRun: false,
      error: `点击后主页提示没有变化（当前${muted ? '仍显示已隐藏' : '没有隐藏提示'}），操作可能没生效`,
      screenshot: await shot(page, opts.screenshotDir, `${op}-verify-${userId}`),
    };
  }

  const opened = await openUserMenu(page, userId);
  const after = opened ? await readMenuLabel(page, spec.selector) : '';
  await closeMenu(page);

  if (opened && after !== '' && after !== before) return { ok: true, dryRun: false };

  return {
    ok: false,
    dryRun: false,
    error: opened
      ? `点击后菜单文字没变（点击前「${before}」，点击后「${after}」），操作可能没生效`
      : '点击后打不开菜单，无法确认状态',
    screenshot: await shot(page, opts.screenshotDir, `${op}-verify-${userId}`),
  };
}
