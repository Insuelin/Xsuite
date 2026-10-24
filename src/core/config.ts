// 运行时配置。默认值保守，环境变量可以覆盖。

import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  dbFile: path.join(root, 'data', 'xsuite.db'),

  /** Edge 的 DevToolsActivePort 文件位置 */
  edgePortFile: path.join(
    os.homedir(),
    'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort',
  ),

  /** 开着这个开关，所有写操作只走流程不真点 */
  dryRun: process.env.XSUITE_DRY_RUN === '1',

  /** 抓取速率 */
  scrape: {
    pageMinMs: num('XSUITE_PAGE_MIN_MS', 2000),
    pageMaxMs: num('XSUITE_PAGE_MAX_MS', 4000),
    /** 快照完整度阈值：抓到的人数 / 主页显示的总数 */
    completenessRatio: num('XSUITE_COMPLETENESS_RATIO', 0.9),
    /** 单次快照最多翻多少页，防止死循环 */
    maxPages: num('XSUITE_MAX_PAGES', 500),
  },

  /** 写操作速率 */
  action: {
    minGapMs: num('XSUITE_ACTION_MIN_MS', 8000),
    maxGapMs: num('XSUITE_ACTION_MAX_MS', 15000),
    perHour: num('XSUITE_ACTIONS_PER_HOUR', 60),
    perDay: num('XSUITE_ACTIONS_PER_DAY', 250),
    /** 连续执行多少条后强制休息 */
    batchSize: num('XSUITE_ACTION_BATCH', 25),
    restMs: num('XSUITE_ACTION_REST_MS', 180000),
    /** 连续失败多少条触发熔断 */
    failureLimit: num('XSUITE_FAILURE_LIMIT', 5),
  },

  /** 页面导航超时 */
  navTimeoutMs: num('XSUITE_NAV_TIMEOUT_MS', 45000),
};
