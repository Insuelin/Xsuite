// 全局浏览器互斥：同一时间只允许一个任务占用工作标签页。
// 抓取与操作都以它为准，避免两个任务抢同一个页面、也不让限速失效。

import { setTimeout as sleep } from 'node:timers/promises';

export type MutexState = 'idle' | 'scraping' | 'acting' | 'paused';

export class BrowserMutex {
  private state: MutexState = 'idle';
  private pauseReason: string | null = null;

  getState(): { state: MutexState; reason: string | null } {
    return { state: this.state, reason: this.pauseReason };
  }

  async acquire(next: 'scraping' | 'acting'): Promise<void> {
    while (this.state !== 'idle') {
      if (this.state === 'paused') {
        throw new Error(`浏览器任务已暂停: ${this.pauseReason ?? '未知原因'}`);
      }
      await sleep(300);
    }
    this.state = next;
  }

  release(): void {
    this.state = 'idle';
    this.pauseReason = null;
  }

  pause(reason: string): void {
    this.pauseReason = reason;
    this.state = 'paused';
  }

  resume(): void {
    this.pauseReason = null;
    this.state = 'idle';
  }
}

/** 在互斥保护下执行一段任务。 */
export async function withBrowserLock<T>(
  mutex: BrowserMutex,
  kind: 'scraping' | 'acting',
  fn: () => Promise<T>,
): Promise<T> {
  await mutex.acquire(kind);
  try {
    return await fn();
  } finally {
    if (mutex.getState().state !== 'paused') mutex.release();
  }
}
