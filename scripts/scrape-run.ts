// 抓取一次关系列表，写入快照并做 diff。
// 用法：node scripts/scrape-run.ts --kind following [--max-scrolls 100]

import { config } from '../src/core/config.ts';
import { openDb, nowIso } from '../src/core/db/client.ts';
import { migrate } from '../src/core/db/migrate.ts';
import { UsersRepo } from '../src/core/db/repos/users.repo.ts';
import { SnapshotsRepo } from '../src/core/db/repos/snapshots.repo.ts';
import { connectEdge } from '../src/core/cdp/connect.ts';
import { WorkTab } from '../src/core/cdp/page.ts';
import { GraphQLInterceptor } from '../src/core/cdp/interceptor.ts';
import { scrapeRelationList } from '../src/core/scrape/lists.ts';
import { computeStats, saveStats } from '../src/core/stats/compute.ts';
import { URLS } from '../src/core/cdp/selectors.ts';
import type { RelationKind } from '../src/shared/domain.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const kind = arg('kind', 'following') as RelationKind;
const maxScrolls = Number(arg('max-scrolls', '100'));

async function main() {
  const db = openDb(config.dbFile);
  migrate(db);
  const usersRepo = new UsersRepo(db);
  const snapshotsRepo = new SnapshotsRepo(db);

  const conn = await connectEdge(config.edgePortFile);
  const ctx = conn.browser.contexts()[0];
  if (!ctx) throw new Error('没有浏览器上下文');

  const work = new WorkTab(ctx);
  const page = await work.ensure();
  const interceptor = new GraphQLInterceptor();
  interceptor.attach(page);

  // 优先用数据库缓存的 handle，避免每次都先打开首页去读
  const cached = db.prepare('SELECT handle FROM accounts LIMIT 1').get() as { handle: string } | undefined;
  let handle = cached?.handle ?? '';

  if (!handle) {
    await page.goto(URLS.home, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForTimeout(3500);
    try {
      const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href', { timeout: 5000 });
      if (href) handle = href.replace(/^\//, '');
    } catch { /* ignore */ }
    if (!handle) throw new Error('拿不到自己的 handle');
    db.prepare(`
      INSERT INTO accounts (id, handle, created_at, updated_at)
      VALUES ('pending', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at
    `).run(handle, nowIso(), nowIso());
    console.log(`handle 已缓存: @${handle}`);
  }
  console.log(`账号: @${handle}`);

  const url =
    kind === 'followers' ? URLS.followers(handle)
    : kind === 'muted' ? URLS.muted
    : kind === 'blocked' ? URLS.blocked
    : URLS.following(handle);

  console.log(`抓取 ${kind}: ${url}`);
  const started = Date.now();

  // 先读主页总数，用于完整度校验
  const counts = await work.readProfileCounts(handle);
  console.log(`  主页显示: 关注 ${counts.following ?? '未知'} / 粉丝 ${counts.followers ?? '未知'}`);

  const result = await scrapeRelationList(page, interceptor, {
    kind,
    url,
    maxScrolls,
    expectedTotal:
      kind === 'following' ? (counts.following ?? undefined)
      : kind === 'followers' ? (counts.followers ?? undefined)
      : undefined,
    onProgress: ({ users, scrolls }) => {
      if (scrolls > 0 && scrolls % 5 === 0) {
        console.log(`  滚动 ${scrolls}，已收集 ${users} 人`);
      }
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n抓取结束: ${result.users.length} 人，滚动 ${result.scrolls} 次，耗时 ${elapsed}s`);
  console.log(`  结束原因: ${result.reason}`);
  console.log(`  底部游标: ${result.bottomCursor?.slice(0, 40) ?? '无'}`);
  console.log(`  游标到底: ${result.complete ? '是' : '否'}`);

  if (!result.sourceUserId) throw new Error('拿不到列表所属账号 ID');
  const accountId = result.sourceUserId;
  console.log(`  accountId: ${accountId}`);

  // 完整度校验：0| 游标到底 + 数量达到主页总数的阈值
  const expectedTotal =
    kind === 'following' ? (counts.following ?? null)
    : kind === 'followers' ? (counts.followers ?? null)
    : null;
  const completeness = expectedTotal && expectedTotal > 0
    ? result.users.length / expectedTotal
    : null;
  const cursorEnd = result.complete;
  const enoughByCount = completeness !== null && completeness >= 0.98;
  const ratioOk = completeness === null || completeness >= config.scrape.completenessRatio;
  // 两种情况都算完整：游标到底，或数量已经达到主页总数的 98%（提前停止）
  const complete = (cursorEnd || enoughByCount) && ratioOk;

  console.log(`  主页显示总数: ${expectedTotal ?? '未知'}`);
  console.log(`  完整度: ${completeness === null ? '未知' : (completeness * 100).toFixed(1) + '%'}`);
  console.log(`  判定: ${complete ? '完整' : '不完整'}`);
  if (cursorEnd && !ratioOk) {
    console.log('  ⚠ 游标到底但数量不到阈值，按残缺处理');
  }

  // 先取上一次完整快照（必须在写入新快照之前）
  const last = snapshotsRepo.getLastComplete(accountId, kind);

  // 写入用户画像与关系状态
  const fetchedAt = nowIso();
  const upsertRel = db.prepare(`
    INSERT INTO relationships (account_id, user_id, kind, active, since, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(account_id, user_id, kind) DO UPDATE SET
      active = 1,
      last_seen_at = excluded.last_seen_at,
      ended_at = NULL
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of result.users) {
      usersRepo.upsert({
        id: u.id,
        handle: u.handle,
        name: u.name,
        bio: u.bio,
        location: u.location,
        followers: u.followers,
        following: u.following,
        tweets: u.tweets,
        mediaCount: u.mediaCount,
        joinedAt: u.joinedAt,
        verified: u.verified,
        blueVerified: u.blueVerified,
        hasAvatar: u.hasAvatar,
        protected: u.protected,
        fetchedAt,
      });
      upsertRel.run(accountId, u.id, kind, fetchedAt, fetchedAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 写快照
  const snapshotId = snapshotsRepo.create(accountId, kind);
  snapshotsRepo.addMembers(snapshotId, result.users.map((u) => u.id));
  snapshotsRepo.finalize(snapshotId, {
    itemCount: result.users.length,
    expectedMin: expectedTotal,
    bottomCursor: result.bottomCursor,
    complete,
  });
  console.log(`  快照 #${snapshotId} 已写入`);

  // 统计（只在完整快照上算，避免残缺数据污染趋势）
  if (complete) {
    const payload = computeStats(db, snapshotId, expectedTotal);
    saveStats(db, { accountId, snapshotId, kind, payload });
    console.log('  统计已写入 stats');
  }

  // Diff
  if (last && complete) {
    const diff = snapshotsRepo.diff(last.id, snapshotId);
    console.log(`\n与上次快照 #${last.id}（${last.takenAt}）对比:`);
    console.log(`  新增 ${diff.appeared.length} 人`);
    console.log(`  消失 ${diff.disappeared.length} 人`);
    for (const id of diff.appeared) {
      snapshotsRepo.recordChange({ accountId, kind, userId: id, change: 'appeared', fromSnapshot: last.id, toSnapshot: snapshotId });
      const u = usersRepo.get(id);
      console.log(`    + @${u?.handle ?? id}`);
    }
    for (const id of diff.disappeared) {
      snapshotsRepo.recordChange({ accountId, kind, userId: id, change: 'disappeared', fromSnapshot: last.id, toSnapshot: snapshotId });
      db.prepare(`
        UPDATE relationships SET active = 0, ended_at = ?
        WHERE account_id = ? AND user_id = ? AND kind = ?
      `).run(nowIso(), accountId, id, kind);
      const u = usersRepo.get(id);
      console.log(`    - @${u?.handle ?? id}`);
    }
  } else if (!last) {
    console.log('\n没有历史快照，这是第一次。');
  } else {
    console.log('\n快照不完整，跳过 diff。');
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  console.log(`\nusers 表共 ${total.n} 条`);

  await work.close().catch(() => {});
  // 注意：不要调用 browser.close()，connectOverCDP 下它会关闭用户整个 Edge
  db.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
