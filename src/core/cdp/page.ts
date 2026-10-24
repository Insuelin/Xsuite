// 专用工作标签页：固定维护一个后台 tab，绝不抢占用户当前正在看的页面。

import type { BrowserContext, Page } from 'playwright-core';
import { URLS } from './selectors.ts';

export class WorkTab {
  private page: Page | null = null;
  private ctx: BrowserContext;

  constructor(ctx: BrowserContext) {
    this.ctx = ctx;
  }

  /** 拿到（必要时创建）工作标签页。永远新建自己的页面，不复用用户正在看的标签页。 */
  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const page = await this.ctx.newPage();
    // 只等导航提交，不等整页资源加载；后续用 waitForSelector 判断内容就绪
    await page.goto(URLS.home, { waitUntil: 'commit', timeout: 60_000 });
    this.page = page;
    return page;
  }

  /** 判断当前是否已登录。 */
  async isLoggedIn(): Promise<boolean> {
    const page = await this.ensure();
    try {
      await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  async goto(url: string): Promise<Page> {
    const page = await this.ensure();
    await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
    return page;
  }

  /**
   * 从个人主页读取关注数/粉丝数，用于快照完整度校验。
   * X 的 Following/Followers 端点不返回账号本身的画像，只能从主页拿。
   */
  async readProfileCounts(handle: string): Promise<{ following: number | null; followers: number | null }> {
    const page = await this.ensure();
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForTimeout(3500);

    return page.evaluate((h: string) => {
      const parse = (el: Element | null): number | null => {
        if (!el) return null;
        const text = (el.textContent || '').replace(/,/g, '');
        const m = text.match(/([\d.]+)\s*([KMB])?/);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (!Number.isFinite(n)) return null;
        const unit = m[2];
        if (unit === 'K') n *= 1e3;
        else if (unit === 'M') n *= 1e6;
        else if (unit === 'B') n *= 1e9;
        return Math.round(n);
      };

      const followingEl =
        document.querySelector(`a[href="/${h}/following"]`) ??
        document.querySelector('a[href$="/following"]');
      const followersEl =
        document.querySelector(`a[href="/${h}/verified_followers"]`) ??
        document.querySelector(`a[href="/${h}/followers"]`) ??
        document.querySelector('a[href$="/verified_followers"]');

      return {
        following: parse(followingEl),
        followers: parse(followersEl),
      };
    }, handle);
  }

  /** 把工作标签页放到后台，不干扰用户。 */
  async park(): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed()) return;
    // 切到另一个页面，让工作页退到后台
    const others = this.ctx.pages().filter((p) => p !== page);
    if (others.length > 0) await others[0].bringToFront().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {});
    this.page = null;
  }
}
