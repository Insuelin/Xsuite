// 进程内事件总线：后台任务往这里发，SSE 从这里取。
// 只做广播，不存历史；新连上来的客户端靠 /api/overview 拉当前状态。

import type { ServerEvent } from '../shared/domain.ts';

type Listener = (e: ServerEvent) => void;

const listeners = new Set<Listener>();
let last: ServerEvent | null = null;

export function emit(e: ServerEvent): void {
  last = e;
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  }
}

export function onEvent(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function lastEvent(): ServerEvent | null {
  return last;
}
