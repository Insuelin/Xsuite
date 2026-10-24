// 本地服务入口：node src/server/index.ts
// 只监听 127.0.0.1:7420，不对外暴露。

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './routes.ts';
import { AppState } from './state.ts';
import { config } from '../core/config.ts';

const PORT = Number(process.env.XSUITE_PORT ?? 7420);
const HOST = '127.0.0.1';

const state = new AppState();
const app = createApp(state);

// 界面打包产物；没打包过就退化成纯 API
const uiDist = path.join(config.root, 'src', 'ui', 'dist');
const hasUi = fs.existsSync(path.join(uiDist, 'index.html'));

if (hasUi) {
  app.use('*', serveStatic({ root: uiDist }));
  // 前端路由回退
  app.get('*', serveStatic({ root: uiDist, path: 'index.html' }));
} else {
  app.get('/', (c) =>
    c.text('界面还没打包。先跑 npm run ui:build，或者直接用 /api/* 接口。'),
  );
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`xsuite 已启动: http://${HOST}:${info.port}`);
  console.log(`  界面: ${hasUi ? uiDist : '未打包，只有 API'}`);
  console.log(`  数据库: ${config.dbFile}`);
});

async function shutdown() {
  console.log('\n正在关闭……');
  await state.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
