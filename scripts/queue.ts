// 操作队列的命令行入口：筛选候选、查看队列、批准或驳回。
//
// 用法：
//   node scripts/queue.ts readiness
//   node scripts/queue.ts propose --limit 50
//   node scripts/queue.ts propose --no-avatar --limit 20 --preview
//   node scripts/queue.ts list pending
//   node scripts/queue.ts approve 12 13 14
//   node scripts/queue.ts approve --all
//   node scripts/queue.ts reject --all
//   node scripts/queue.ts stats

import { config } from '../src/core/config.ts';
import { openDb } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { ActionsRepo } from '../src/core/db/repos/actions.repo.ts';
import {
  checkReadiness,
  describeFilter,
  findUnfollowCandidates,
  type CandidateFilter,
} from '../src/core/filter/candidates.ts';
import type { ActionKind, ActionStatus } from '../src/shared/domain.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function needAccountId(db: ReturnType<typeof openDb>): string {
  const row = db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string } | undefined;
  if (!row) throw new Error('accounts 表是空的，先跑一次抓取');
  return row.id;
}

function statusOf(): ActionStatus | undefined {
  const v = process.argv[3];
  const valid: ActionStatus[] = ['pending', 'approved', 'running', 'done', 'failed', 'skipped'];
  return valid.includes(v as ActionStatus) ? (v as ActionStatus) : undefined;
}

function fmtDays(d: number | null): string {
  if (d === null) return '?';
  if (d < 1) return '<1天';
  if (d < 365) return `${d}天`;
  return `${(d / 365).toFixed(1)}年`;
}

function main(): void {
  const db = openDb(config.dbFile);
  migrate(db);
  const repo = new ActionsRepo(db);
  const cmd = process.argv[2];

  if (cmd === 'readiness') {
    const accountId = needAccountId(db);
    const r = checkReadiness(db, accountId);
    console.log(`关注快照: ${r.following ? `#${r.following.id} ${r.following.itemCount} 人 ${r.following.takenAt}` : '无'}`);
    console.log(`粉丝快照: ${r.followers ? `#${r.followers.id} ${r.followers.itemCount} 人 ${r.followers.takenAt}` : '无'}`);
    for (const p of r.problems) console.log(`  ✗ ${p}`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
    console.log(r.ok ? '可以筛选' : '数据不全，先抓一次再筛');
  } else if (cmd === 'propose') {
    const accountId = needAccountId(db);
    const ready = checkReadiness(db, accountId);
    if (!ready.ok) {
      for (const p of ready.problems) console.log(`✗ ${p}`);
      console.log('数据不全，先抓一次再筛。');
      return;
    }
    for (const w of ready.warnings) console.log(`! ${w}`);

    const filter: CandidateFilter = {
      requireNoFollowBack: !has('include-follow-back'),
      excludeProtected: !has('include-protected'),
      noAvatar: has('no-avatar'),
      zeroTweets: has('zero-tweets'),
      minFollowDays: Number(arg('min-days', '0')),
      maxFollowers: arg('max-followers') ? Number(arg('max-followers')) : undefined,
      limit: arg('limit') ? Number(arg('limit')) : undefined,
    };

    const candidates = findUnfollowCandidates(db, accountId, filter);
    console.log(`筛选条件: ${describeFilter(filter)}`);
    console.log(`候选 ${candidates.length} 人\n`);

    for (const c of candidates.slice(0, 30)) {
      console.log(
        `  @${c.handle.padEnd(18)} ${String(c.followers ?? '?').padStart(7)} 粉丝  ` +
        `${String(c.tweets ?? '?').padStart(6)} 推文  ${fmtDays(c.followDays).padStart(6)}  ` +
        `${c.hasAvatar ? '' : '[无头像]'}${c.name ?? ''}`,
      );
    }
    if (candidates.length > 30) console.log(`  …… 还有 ${candidates.length - 30} 人`);

    if (has('preview')) {
      console.log('\n--preview：没有写入队列');
      return;
    }
    if (candidates.length === 0) return;

    const n = repo.propose({
      accountId,
      kind: 'unfollow',
      targetIds: candidates.map((c) => c.userId),
      source: 'filter',
      reason: describeFilter(filter),
      batchId: `filter-${Date.now()}`,
    });
    console.log(`\n已写入 ${n} 条 pending。确认后执行：node scripts/queue.ts approve --all`);
  } else if (cmd === 'add') {
    const accountId = needAccountId(db);
    const kind = (arg('kind', 'unfollow') ?? 'unfollow') as ActionKind;
    const userArg = arg('user');
    const handleArg = arg('handle');

    let userId = userArg;
    if (!userId && handleArg) {
      const row = db
        .prepare('SELECT id FROM users WHERE handle = ?')
        .get(handleArg.replace(/^@/, '')) as { id: string } | undefined;
      if (!row) throw new Error(`users 表里没有 @${handleArg}，先抓一次列表`);
      userId = row.id;
    }
    if (!userId) throw new Error('用 --user <数字 id> 或 --handle <用户名> 指定目标');

    const n = repo.propose({
      accountId,
      kind,
      targetIds: [userId],
      source: 'manual',
      reason: '手动添加',
    });
    console.log(n > 0 ? `已加入队列：${kind} ${userId}` : `已在队列里，跳过：${kind} ${userId}`);
  } else if (cmd === 'list') {
    const status = statusOf();
    const rows = repo.list(status);
    if (rows.length === 0) {
      console.log(status ? `没有 ${status} 的任务` : '队列是空的');
      return;
    }
    const get = db.prepare('SELECT handle FROM users WHERE id = ?');
    for (const a of rows) {
      const u = get.get(a.targetId) as { handle: string } | undefined;
      const who = u ? `@${u.handle}` : a.targetId;
      console.log(
        `#${String(a.id).padStart(4)} ${a.status.padEnd(8)} ${a.kind.padEnd(9)} ${who}` +
        `${a.error ? `  (${a.error})` : ''}`,
      );
    }
    console.log(`\n共 ${rows.length} 条`);
  } else if (cmd === 'approve' || cmd === 'reject') {
    const rest = process.argv.slice(3).filter((x) => !x.startsWith('--'));
    const ids = has('all')
      ? (cmd === 'approve' ? repo.list('pending') : repo.listOpen()).map((a) => a.id)
      : rest.map(Number).filter((n) => Number.isInteger(n) && n > 0);

    if (ids.length === 0) {
      console.log('没有指定任务。用 --all 或列出 id。');
      return;
    }
    const n = cmd === 'approve' ? repo.approve(ids) : repo.reject(ids);
    console.log(`${cmd === 'approve' ? '批准' : '驳回'}了 ${n} 条`);
  } else if (cmd === 'stats') {
    const s = repo.stats();
    const accountId = needAccountId(db);
    const total = db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
    console.log(`待批准 ${s.pending} · 已批准 ${s.approved} · 执行中 ${s.running} · 完成 ${s.done} · 失败 ${s.failed}`);
    console.log(`今日取关 ${repo.usedToday(accountId, 'unfollow')} / ${config.action.perDay}`);
    console.log(`最近一小时 ${repo.usedLastHour(accountId, 'unfollow')} / ${config.action.perHour}`);
    console.log(`历史累计 ${total.n} 条`);
  } else {
    console.log('用法: node scripts/queue.ts <readiness|propose|list|approve|reject|stats>');
  }

  db.close();
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
