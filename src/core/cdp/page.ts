// 专用工作标签页：固定维护一个后台 tab，绝不抢占用户当前正在看的页面。

import type { BrowserContext, Page } from 'playwright-core';
import { URLS } from './selectors.ts';

export class WorkTab {
  private page: Page | null = null;
  private ctx: BrowserContext;

  constructor(ctx: BrowserContext) {
    this.ctx = ctx;
  }

  /** 拿到（必要时创建）工作标签页。 */
  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const existing = this.ctx.pages().find((p) => !p.isClosed() && p.url().includes('x.com'));
    if (existing) {
      this.page = existing;
      return existing;
    }

    const page = await this.ctx.newPage();
    await page.goto(URLS.home, { waitUntil: 'domcontentloaded', timeout: 45_000 });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return page;
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
