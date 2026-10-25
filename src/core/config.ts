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

  /**
   * 鼠标轨迹回放。语料是从公开数据集里切出来的真人移动段，
   * 索引在 data/trajectories/ 下，由 scripts/build-segments.ts 生成。
   */
  replay: {
    /** XSUITE_REPLAY=0 关掉，退回普通点击 */
    enabled: process.env.XSUITE_REPLAY !== '0',
    dir: path.join(root, 'data', 'trajectories'),
    /** 优先用 sapimouse，它的段更长更完整 */
    datasets: ['sapimouse', 'guidaeta'],
    /** 叠加扰动的最大幅度，像素 */
    jitterPx: num('XSUITE_REPLAY_JITTER', 1.2),
    /**
     * 每隔多少天换一个受试者。0 表示不换，一直用同一个人。
     *
     * 检测器的观测窗口最多到「这一次浏览器开着」或者「这一天」，
     * 跨周的一致性它根本看不到。所以默认按天换，会话内保持一致。
     * 换的人从段数最多的几位里挑，免得一天没做完就换手。
     */
    rotateDays: num('XSUITE_REPLAY_ROTATE_DAYS', 1),
    /**
     * 同一条轨迹隔多少天可以再用。0 表示只要用过就一直不用。
     *
     * 能比对的历史最多到「这一次浏览器开着」或「这一天」，跨过 3 天
     * 再出现一次没有任何意义，而真人的轨迹里重复形状本来就多。
     * 冷却期内不复用，是为了避开「同一会话里两次一模一样」这个最好抓的点。
     */
    reuseAfterDays: num('XSUITE_REPLAY_REUSE_DAYS', 3),
    /** 不同账号用不同相位，避免所有号在同一天一起换手感 */
    subjectOffset: process.env.XSUITE_REPLAY_OFFSET ? num('XSUITE_REPLAY_OFFSET', 0) : null,
  },
};
