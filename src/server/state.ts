// 本地服务共享状态：一个数据库连接、一个浏览器互斥、最多一个后台任务。

import type { Browser } from 'playwright-core';
import { config } from '../core/config.ts';
import { openDb, type Db } from '../core/db/client.ts';
import { migrate } from '../core/db/migrate.ts';
import { BrowserMutex } from '../core/scheduler/mutex.ts';
import { connectEdge } from '../core/cdp/connect.ts';
import { WorkTab } from '../core/cdp/page.ts';

export interface JobInfo {
  kind: 'scrape' | 'actions';
  label: string;
  startedAt: string;
}

export class AppState {
  readonly db: Db;
  readonly mutex = new BrowserMutex();
  job: JobInfo | null = null;

  private work: WorkTab | null = null;
  private browser: Browser | null = null;

  constructor(dbFile = config.dbFile) {
    this.db = openDb(dbFile);
    migrate(this.db);
  }

  accountId(): string {
    const row = this.db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string } | undefined;
    if (!row) throw new Error('还没有账号记录，先抓一次列表');
    return row.id;
  }

  handle(): string {
    const row = this.db.prepare('SELECT handle FROM accounts LIMIT 1').get() as { handle: string } | undefined;
    return row?.handle ?? '';
  }

  /** 连上用户的 Edge，并一直复用同一个工作标签页。 */
  async getWork(): Promise<WorkTab> {
    if (this.work && this.browser?.isConnected()) return this.work;

    const conn = await connectEdge(config.edgePortFile);
    this.browser = conn.browser;
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.work = null;
    });

    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('没有浏览器上下文');
    this.work = new WorkTab(ctx);
    return this.work;
  }

  async close(): Promise<void> {
    // 只关自己的标签页，绝不 browser.close()，那会把用户的 Edge 一起关掉
    await this.work?.close().catch(() => {});
    this.work = null;
    this.db.close();
  }
}
