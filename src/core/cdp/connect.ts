// 连接用户日常使用的 Edge。复用主 Profile 是防风控的核心策略：
// 独立空白 profile 缺少日常浏览历史，自动化冷启动特征明显。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { config } from '../config.ts';

export interface ConnectResult {
  browser: Browser;
  port: string;
  contexts: number;
  pages: number;
}

export interface ConnectOptions {
  /** 自动点掉 Edge 的「是否允许远程调试?」弹窗，默认开 */
  autoApprove?: boolean;
  /** 连接失败重试次数。弹窗没被点掉时 Edge 会直接 403，重试往往能过 */
  attempts?: number;
}

/**
 * 启动 UI Automation 点击器，等它自己找到弹窗并点「允许」。
 * 脚本会在成功点击或超时后自行退出。输出写到 data/approve-debug.log，方便排查。
 */
function startAutoApprove(): ChildProcess | null {
  const script = path.join(import.meta.dirname, '../../../scripts/approve-debug.ps1');
  if (!fs.existsSync(script)) return null;

  let stdio: StdioOptions = 'ignore';
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const fd = fs.openSync(path.join(config.dataDir, 'approve-debug.log'), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    /* 日志写不了就算了，不影响主流程 */
  }

  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TimeoutSec', '60', '-Verbose'],
    { stdio, windowsHide: true },
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
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown = null;

  for (let i = 1; i <= attempts; i++) {
    const clicker = autoApprove ? startAutoApprove() : null;
    try {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${wsPath}`, {
        timeout: 45_000,
      });

      return {
        browser,
        port,
        contexts: browser.contexts().length,
        pages: browser.contexts().reduce((n, c) => n + c.pages().length, 0),
      };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|Forbidden|Connection rejected/i.test(msg) && i < attempts) {
        console.log(`  连接被拒（授权弹窗可能没点上），第 ${i + 1} 次重试……`);
      }
    } finally {
      clicker?.kill();
    }
  }

  throw lastErr instanceof Error
    ? new Error(`连不上 Edge 的调试端口 ${port}：${lastErr.message.split('\n')[0]}\n弹窗出现时手动点一下「允许」也可以。`)
    : new Error(`连不上 Edge 的调试端口 ${port}`);
}
