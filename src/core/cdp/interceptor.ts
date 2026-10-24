// 被动拦截浏览器自己发出的 GraphQL 响应。
// 不主动请求，只监听；所有请求仍然由页面原生发出，指纹不变。

import type { Page, Response } from 'playwright-core';
import { GRAPHQL_MATCHERS } from './selectors.ts';
import type { RelationKind } from '../../shared/domain.ts';

export type GraphQLKind =
  | RelationKind
  | 'userTweets'
  | 'search'
  | 'unknown';

export interface CapturedResponse {
  kind: GraphQLKind;
  url: string;
  status: number;
  json: unknown;
  at: number;
}

function classify(url: string): GraphQLKind {
  for (const [kind, re] of Object.entries(GRAPHQL_MATCHERS)) {
    if (re.test(url)) return kind as GraphQLKind;
  }
  return 'unknown';
}

export class GraphQLInterceptor {
  private handlers: ((r: CapturedResponse) => void)[] = [];
  private seen = 0;

  attach(page: Page): void {
    page.on('response', (res: Response) => {
      void this.handle(res);
    });
  }

  on(fn: (r: CapturedResponse) => void): () => void {
    this.handlers.push(fn);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== fn);
    };
  }

  get count(): number {
    return this.seen;
  }

  private async handle(res: Response): Promise<void> {
    const url = res.url();
    if (!url.includes('/i/api/graphql/')) return;

    const kind = classify(url);
    if (kind === 'unknown') return;

    let json: unknown;
    try {
      // 有些响应体在回调触发时已经被释放，读失败就跳过，不中断其他响应
      json = await res.json();
    } catch {
      return;
    }

    this.seen++;
    const captured: CapturedResponse = {
      kind,
      url,
      status: res.status(),
      json,
      at: Date.now(),
    };
    for (const h of this.handlers) {
      try {
        h(captured);
      } catch {
        /* 单个处理器出错不影响其他 */
      }
    }
  }
}
