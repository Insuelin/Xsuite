// 连接用户日常使用的 Edge。复用主 Profile 是防风控的核心策略：
// 独立空白 profile 缺少日常浏览历史，自动化冷启动特征明显。

import fs from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

export interface ConnectResult {
  browser: Browser;
  port: string;
  contexts: number;
  pages: number;
}

export async function connectEdge(portFile: string): Promise<ConnectResult> {
  if (!fs.existsSync(portFile)) {
    throw new Error(
      `找不到 ${portFile}\n` +
      '先在 Edge 打开远程调试：地址栏输入 edge://inspect 或启动时加 --remote-debugging-port=9222。\n' +
      '另外要关闭「启动增强」和「关闭浏览器后继续运行后台扩展」，否则启动参数不生效。',
    );
  }

  const raw = fs.readFileSync(portFile, 'utf8').trim();
  const [port, wsPath] = raw.split(/\r?\n/);
  if (!port || !wsPath) {
    throw new Error(`DevToolsActivePort 内容异常: ${JSON.stringify(raw)}`);
  }

  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${wsPath}`, {
    timeout: 120_000,
  });

  return {
    browser,
    port,
    contexts: browser.contexts().length,
    pages: browser.contexts().reduce((n, c) => n + c.pages().length, 0),
  };
}
