// 连接用户日常使用的 Edge。复用主 Profile 是防风控的核心策略：
// 独立空白 profile 缺少日常浏览历史，自动化冷启动特征明显。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';

export interface ConnectResult {
  browser: Browser;
  port: string;
  contexts: number;
  pages: number;
}

export interface ConnectOptions {
  /** 自动点掉 Edge 的「是否允许远程调试?」弹窗，默认开 */
  autoApprove?: boolean;
}

/**
 * 启动 UI Automation 点击器，等它自己找到弹窗并点「允许」。
 * 脚本会在成功点击或超时后自行退出。
 */
function startAutoApprove(): ChildProcess | null {
  const script = path.join(import.meta.dirname, '../../../scripts/approve-debug.ps1');
  if (!fs.existsSync(script)) return null;

  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TimeoutSec', '120'],
    { stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => { /* 忽略：没有 PowerShell 就退回手动点 */ });
  return child;
}

export async function connectEdge(portFile: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
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

  const autoApprove = opts.autoApprove ?? process.env.XSUITE_NO_AUTO_APPROVE !== '1';
  const clicker = autoApprove ? startAutoApprove() : null;

  try {
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${wsPath}`, {
      timeout: 120_000,
    });

    return {
      browser,
      port,
      contexts: browser.contexts().length,
      pages: browser.contexts().reduce((n, c) => n + c.pages().length, 0),
    };
  } finally {
    clicker?.kill();
  }
}
