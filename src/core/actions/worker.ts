// 操作执行器：从 approved 队列里逐条取出来执行。
//
// 三层保护：
//   1. 白名单在提报时过滤一次，执行前再查一次
//   2. 每日 / 每小时配额，超了就先停下，任务留在队列里
//   3. 连续失败达到阈值直接停，不硬撑

import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import { ActionsRepo } from '../db/repos/actions.repo.ts';
import { UsersRepo } from '../db/repos/users.repo.ts';
import {
  blockUser,
  followUser,
  muteUser,
  unblockUser,
  unfollowUser,
  unmuteUser,
  type ActionOptions,
  type ActionResult,
} from '../cdp/actions.ts';
import { ReplayRepo } from '../db/repos/replay.repo.ts';
import { currentSubjectPoolLabel } from '../replay/index.ts';
import type { BrowserMutex } from '../scheduler/mutex.ts';
import { config } from '../config.ts';
import type { Action, ActionKind, ServerEvent } from '../../shared/domain.ts';

/** 每种操作在日志和提示里的说法 */
const VERB: Record<ActionKind, string> = {
  follow: '关注',
  unfollow: '取关',
  mute: '隐藏',
  unmute: '取消隐藏',
  block: '屏蔽',
  unblock: '取消屏蔽',
  delete_tweet: '删推',
  unlike: '取消点赞',
};

/** 操作类型 → 执行器。没有条目就是还没实现 */
const EXECUTOR: Partial<
  Record<ActionKind, (page: Page, userId: string, opts: ActionOptions) => Promise<ActionResult>>
> = {
  follow: followUser,
  unfollow: unfollowUser,
  mute: muteUser,
  unmute: unmuteUser,
  block: blockUser,
  unblock: unblockUser,
};

/** 目前实现了执行的动作类型 */
const SUPPORTED: ActionKind[] = Object.keys(EXECUTOR) as ActionKind[];

export interface ActionWorkerOptions {
  db: Db;
  accountId: string;
  page: Page;
  dryRun: boolean;
  mutex: BrowserMutex;
  /** 最多执行多少条，不传就跑到队列空 */
  maxActions?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  onEvent?: (e: ServerEvent) => void;
}

export interface WorkerResult {
  attempted: number;
  done: number;
  failed: number;
  skipped: number;
  stoppedBy: 'empty' | 'quota' | 'circuit-breaker' | 'max' | 'aborted';
  reason?: string;
}

function label(action: Action, users: UsersRepo): string {
  const u = users.get(action.targetId);
  return u ? `@${u.handle}` : action.targetId;
}

function gapMs(): number {
  const { minGapMs, maxGapMs } = config.action;
  return minGapMs + Math.floor(Math.random() * Math.max(1, maxGapMs - minGapMs));
}

/**
 * 成功后同步本地状态。
 * changes 的 from/to 快照填 0，表示「这条变化来自自己的操作，不是快照对比出来的」。
 */
/** 每种操作对本地关系表的含义。delete_tweet 不碰关系。 */
const RELATION_EFFECT: Record<
  ActionKind,
  { kind: 'following' | 'muted' | 'blocked'; active: 0 | 1 } | null
> = {
  follow: { kind: 'following', active: 1 },
  unfollow: { kind: 'following', active: 0 },
  mute: { kind: 'muted', active: 1 },
  unmute: { kind: 'muted', active: 0 },
  block: { kind: 'blocked', active: 1 },
  unblock: { kind: 'blocked', active: 0 },
  delete_tweet: null,
  unlike: null,
};

function markRelationship(db: Db, accountId: string, userId: string, kind: ActionKind, actionId: number): void {
  const eff = RELATION_EFFECT[kind];
  if (!eff) return;
  const at = nowIso();

  if (eff.active === 0) {
    db.prepare(`
      UPDATE relationships SET active = 0, ended_at = ?
      WHERE account_id = ? AND user_id = ? AND kind = ? AND active = 1
    `).run(at, accountId, userId, eff.kind);
  } else {
    db.prepare(`
      INSERT INTO relationships (account_id, user_id, kind, active, since, last_seen_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(account_id, user_id, kind) DO UPDATE SET
        active = 1, last_seen_at = excluded.last_seen_at, ended_at = NULL
    `).run(accountId, userId, eff.kind, at, at);
  }

  // 屏蔽会把关注关系一起断掉，本地状态跟着改，不然下次筛未回关会算错
  if (kind === 'block') {
    db.prepare(`
      UPDATE relationships SET active = 0, ended_at = ?
      WHERE account_id = ? AND user_id = ? AND kind = 'following' AND active = 1
    `).run(at, accountId, userId);
  }

  db.prepare(`
    INSERT INTO changes (account_id, kind, user_id, change, action_id, detected_at, from_snapshot, to_snapshot)
    VALUES (?, ?, ?, 'self_action', ?, ?, 0, 0)
  `).run(accountId, eff.kind, userId, actionId, at);
}

export async function runActionQueue(opts: ActionWorkerOptions): Promise<WorkerResult> {
  const { db, accountId, page, dryRun, mutex } = opts;
  const log = opts.log ?? (() => {});
  const emit = opts.onEvent ?? (() => {});
  const actions = new ActionsRepo(db);
  const users = new UsersRepo(db);
  // 同一条真人轨迹在整个账号生命周期里只用一次
  const replayUsed = new ReplayRepo(db, config.replay.reuseAfterDays);
  // 每个账号一个相位，轮换不会所有号同一天换手感
  const subjectOffset = hashToOffset(accountId);

  /** 队列各状态的数量变了就推一次，界面上的角标靠它实时刷新 */
  const emitProgress = (): void => {
    const s = actions.stats();
    emit({
      type: 'queue:progress',
      pending: s.pending,
      approved: s.approved,
      done: s.done,
      failed: s.failed,
    });
  };

  const result: WorkerResult = {
    attempted: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    stoppedBy: 'empty',
  };

  const poolLabel = currentSubjectPoolLabel(subjectOffset);
  if (poolLabel) log(`轨迹回放：${poolLabel}`);
  log(`轨迹复用冷却：${config.replay.reuseAfterDays} 天，当前占住 ${replayUsed.count()} 条`);

  const replaced = actions.resetRunning();
  if (replaced > 0) emitProgress();
  if (replaced > 0) log(`  ${replaced} 条上次中断的任务已放回 approved`);

  await mutex.acquire('acting');
  try {
    let sinceRest = 0;
    let consecutiveFailures = 0;
    let first = true;

    while (true) {
      if (opts.signal?.aborted) {
        result.stoppedBy = 'aborted';
        break;
      }
      if (opts.maxActions !== undefined && result.attempted >= opts.maxActions) {
        result.stoppedBy = 'max';
        break;
      }

      const action = actions.claimNext();
      if (!action) {
        result.stoppedBy = 'empty';
        break;
      }

      // 白名单二次拦截
      if (users.isWhitelisted(accountId, action.targetId)) {
        actions.skip(action.id, '白名单');
        result.skipped++;
        log(`  跳过 #${action.id} ${label(action, users)}：在白名单里`);
        continue;
      }

      if (!SUPPORTED.includes(action.kind)) {
        actions.skip(action.id, `未实现的操作: ${action.kind}`);
        result.skipped++;
        log(`  跳过 #${action.id}：${action.kind} 还没实现`);
        continue;
      }

      const used = actions.usedToday(accountId, action.kind);
      if (used >= config.action.perDay) {
        actions.release(action.id);
        result.stoppedBy = 'quota';
        result.reason = `今天已${VERB[action.kind]} ${used} 人，达到上限 ${config.action.perDay}`;
        break;
      }
      const usedHour = actions.usedLastHour(accountId, action.kind);
      if (usedHour >= config.action.perHour) {
        actions.release(action.id);
        result.stoppedBy = 'quota';
        result.reason = `最近一小时已${VERB[action.kind]} ${usedHour} 人，达到上限 ${config.action.perHour}`;
        break;
      }

      if (!first) await sleep(gapMs());
      first = false;

      result.attempted++;
      const name = label(action, users);
      const verb = VERB[action.kind];
      log(`[${result.attempted}] #${action.id} ${verb} ${name}${dryRun ? '（dry-run，不会真的点）' : ''}`);

      const fn = EXECUTOR[action.kind]!;
      const res = await fn(page, action.targetId, {
        dryRun,
        screenshotDir: path.join(config.dataDir, 'screenshots'),
        used: replayUsed,
        subjectOffset,
      }).catch((err: unknown) => ({
        ok: false,
        dryRun,
        error: err instanceof Error ? err.message : String(err),
      }));

      if (res.ok) {
        actions.finish(action.id, true, { dryRun });
        if (!dryRun) {
          markRelationship(db, accountId, action.targetId, action.kind, action.id);
          actions.consumeQuota(accountId, action.kind);
        }
        result.done++;
        consecutiveFailures = 0;
        log(`    ok${res.error ? `（${res.error}）` : ''}`);
        emit({ type: 'action:executed', actionId: action.id, kind: action.kind, targetId: action.targetId, ok: true });
      } else {
        actions.finish(action.id, false, { error: res.error ?? '未知错误', dryRun });
        result.failed++;
        consecutiveFailures++;
        log(`    失败: ${res.error ?? '未知错误'}`);
        emit({
          type: 'action:executed',
          actionId: action.id,
          kind: action.kind,
          targetId: action.targetId,
          ok: false,
          error: res.error,
        });

        if (consecutiveFailures >= config.action.failureLimit) {
          result.stoppedBy = 'circuit-breaker';
          result.reason = `连续失败 ${consecutiveFailures} 条，停止执行`;
          break;
        }
      }

      // 每执行完一条就推一次，前端队列页的数字不用等轮询
      emitProgress();

      sinceRest++;
      if (sinceRest >= config.action.batchSize) {
        log(`  连续 ${sinceRest} 条，休息 ${Math.round(config.action.restMs / 1000)} 秒`);
        await sleep(config.action.restMs);
        sinceRest = 0;
      }
    }
  } finally {
    mutex.release();
  }

  emitProgress();
  return result;
}

/** 账号 id 散成一个整数，用作受试者轮换的相位。同一个号每次都一样。 */
function hashToOffset(accountId: string): number {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}
