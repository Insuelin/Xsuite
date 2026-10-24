// 诊断用：短超时连接一次，不关闭浏览器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const file = path.join(
  os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort',
);
const [port, ws] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);

try {
  const b = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${ws}`, { timeout: 20000 });
  console.log('connected, contexts=' + b.contexts().length);
  process.exit(0);
} catch (e) {
  console.log('failed: ' + String(e.message).split('\n')[0]);
  process.exit(1);
}
