// 抓取一次关系列表：滚页面 → 被动拦截 GraphQL → 写用户、关系、快照、统计、diff。
// 命令行和本地服务共用这一份逻辑。

import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import { UsersRepo } from '../db/repos/users.repo.ts';
import { SnapshotsRepo } from '../db/repos/snapshots.repo.ts';
import { GraphQLInterceptor } from '../cdp/interceptor.ts';
import { URLS } from '../cdp/selectors.ts';
import { scrapeRelationList } from '../scrape/lists.ts';
import { computeStats, saveStats } from '../stats/compute.ts';
import { config } from '../config.ts';
import type { RelationKind, ServerEvent } from '../../shared/domain.ts';

export interface ScrapeJobOptions {
  db: Db;
  page: Page;
  kind: RelationKind;
  /** 已经缓存的 handle，没有就去首页读一次 */
  handle?: string;
  maxScrolls?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  onEvent?: (e: ServerEvent) => void;
}

export interface ScrapeJobResult {
  accountId: string;
  handle: string;
  users: number;
  scrolls: number;
  complete: boolean;
  expectedTotal: number | null;
  completeness: number | null;
  snapshotId: number;
  appeared: number;
  disappeared: number;
  elapsedMs: number;
}

function readCachedHandle(db: Db): string {
  const row = db.prepare('SELECT handle FROM accounts LIMIT 1').get() as { handle: string } | undefined;
  return row?.handle ?? '';
}

/** 从页面上读自己的 handle，并把 account 写进库。 */
async function resolveHandle(db: Db, page: Page, log: (m: string) => void): Promise<string> {
  const cached = readCachedHandle(db);
  if (cached) return cached;

  await page.goto(URLS.home, { waitUntil: 'commit', timeout: 60_000 });
  await sleep(3500);
  let handle = '';
  try {
    const href = await page
      .locator('[data-testid="AppTabBar_Profile_Link"]')
      .first()
      .getAttribute('href', { timeout: 5000 });
    if (href) handle = href.replace(/^\//, '');
  } catch {
    /* ignore */
  }
  if (!handle) throw new Error('拿不到自己的 handle');

  db.prepare(`
    INSERT INTO accounts (id, handle, created_at, updated_at)
    VALUES ('pending', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at
  `).run(handle, nowIso(), nowIso());
  log(`handle 已缓存: @${handle}`);
  return handle;
}

/** 从个人主页读关注数/粉丝数，只对 following / followers 有意义。 */
async function readCounts(page: Page, handle: string) {
  await page.goto(`https://x.com/${handle}`, { waitUntil: 'commit', timeout: 60_000 });
  await page.waitForTimeout(3500);

  return page.evaluate((h: string) => {
    const parse = (el: Element | null): number | null => {
      if (!el) return null;
      const text = (el.textContent || '').replace(/,/g, '');
      const m = text.match(/([\d.]+)\s*([KMB])?/);
      if (!m) return null;
      let n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return null;
      if (m[2] === 'K') n *= 1e3;
      else if (m[2] === 'M') n *= 1e6;
      else if (m[2] === 'B') n *= 1e9;
      return Math.round(n);
    };
    return {
      following: parse(
        document.querySelector(`a[href="/${h}/following"]`) ??
        document.querySelector('a[href$="/following"]'),
      ),
      followers: parse(
        document.querySelector(`a[href="/${h}/verified_followers"]`) ??
        document.querySelector(`a[href="/${h}/followers"]`) ??
        document.querySelector('a[href$="/followers"]'),
      ),
    };
  }, handle);
}

export async function runScrapeJob(opts: ScrapeJobOptions): Promise<ScrapeJobResult> {
  const { db, page, kind } = opts;
  const log = opts.log ?? (() => {});
  const emit = opts.onEvent ?? (() => {});
  const usersRepo = new UsersRepo(db);
  const snapshotsRepo = new SnapshotsRepo(db);

  const started = Date.now();
  const handle = opts.handle || (await resolveHandle(db, page, log));
  log(`账号: @${handle}`);

  const url =
    kind === 'followers' ? URLS.followers(handle)
    : kind === 'muted' ? URLS.muted
    : kind === 'blocked' ? URLS.blocked
    : URLS.following(handle);

  log(`抓取 ${kind}: ${url}`);

  const counts = kind === 'following' || kind === 'followers'
    ? await readCounts(page, handle)
    : { following: null as number | null, followers: null as number | null };
  log(`  主页显示: 关注 ${counts.following ?? '未知'} / 粉丝 ${counts.followers ?? '未知'}`);

  const interceptor = new GraphQLInterceptor();
  interceptor.attach(page);

  const result = await scrapeRelationList(page, interceptor, {
    kind,
    url,
    maxScrolls: opts.maxScrolls ?? config.scrape.maxPages,
    expectedTotal:
      kind === 'following' ? (counts.following ?? undefined)
      : kind === 'followers' ? (counts.followers ?? undefined)
      : undefined,
    onProgress: ({ users, scrolls }) => {
      if (scrolls > 0 && scrolls % 2 === 0) {
        emit({ type: 'scrape:progress', kind, page: scrolls, items: users });
        log(`  滚动 ${scrolls}，已收集 ${users} 人`);
      }
    },
  });

  log(`\n抓取结束: ${result.users.length} 人，滚动 ${result.scrolls} 次`);
  log(`  结束原因: ${result.reason}，游标到底: ${result.complete ? '是' : '否'}`);

  const cachedAccount = db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string } | undefined;
  const accountId = result.sourceUserId ?? cachedAccount?.id;
  if (!accountId) throw new Error('拿不到列表所属账号 ID');

  const expectedTotal =
    kind === 'following' ? (counts.following ?? null)
    : kind === 'followers' ? (counts.followers ?? null)
    : null;
  const completeness = expectedTotal && expectedTotal > 0 ? result.users.length / expectedTotal : null;
  const ratioOk = completeness === null || completeness >= config.scrape.completenessRatio;
  // 只看游标：主页计数里可能包含列表不可见的账号，数量天然会少几个
  const complete = result.complete;
  if (complete && !ratioOk) log('  ⚠ 已到底，但数量明显少于主页计数，可能有隐藏账号');
  log(`  完整度: ${completeness === null ? '未知' : (completeness * 100).toFixed(1) + '%'}`);

  const last = snapshotsRepo.getLastComplete(accountId, kind);

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

  const snapshotId = snapshotsRepo.create(accountId, kind);
  snapshotsRepo.addMembers(snapshotId, result.users.map((u) => u.id));
  snapshotsRepo.finalize(snapshotId, {
    itemCount: result.users.length,
    expectedMin: expectedTotal,
    bottomCursor: result.bottomCursor,
    complete,
  });
  log(`  快照 #${snapshotId} 已写入`);

  if (complete) {
    db.prepare(`
      UPDATE relationships SET active = 0, ended_at = ?
      WHERE account_id = ? AND kind = ? AND active = 1
        AND user_id NOT IN (SELECT user_id FROM snapshot_members WHERE snapshot_id = ?)
    `).run(nowIso(), accountId, kind, snapshotId);

    saveStats(db, {
      accountId,
      snapshotId,
      kind,
      payload: computeStats(db, snapshotId, expectedTotal),
    });
  }

  let appeared = 0;
  let disappeared = 0;
  if (last && complete) {
    const diff = snapshotsRepo.diff(last.id, snapshotId);
    appeared = diff.appeared.length;
    disappeared = diff.disappeared.length;
    log(`\n与上次快照 #${last.id} 对比: 新增 ${appeared}，消失 ${disappeared}`);

    for (const id of diff.appeared) {
      snapshotsRepo.recordChange({
        accountId, kind, userId: id, change: 'appeared',
        fromSnapshot: last.id, toSnapshot: snapshotId,
      });
      const u = usersRepo.get(id);
      log(`    + @${u?.handle ?? id}`);
    }
    for (const id of diff.disappeared) {
      snapshotsRepo.recordChange({
        accountId, kind, userId: id, change: 'disappeared',
        fromSnapshot: last.id, toSnapshot: snapshotId,
      });
      db.prepare(`
        UPDATE relationships SET active = 0, ended_at = ?
        WHERE account_id = ? AND user_id = ? AND kind = ?
      `).run(nowIso(), accountId, id, kind);
      const u = usersRepo.get(id);
      log(`    - @${u?.handle ?? id}`);
    }
  } else if (!last) {
    log('\n没有历史快照，这是第一次。');
  } else {
    log('\n快照不完整，跳过 diff。');
  }

  emit({ type: 'scrape:done', kind, snapshotId, items: result.users.length, complete });

  return {
    accountId,
    handle,
    users: result.users.length,
    scrolls: result.scrolls,
    complete,
    expectedTotal,
    completeness,
    snapshotId,
    appeared,
    disappeared,
    elapsedMs: Date.now() - started,
  };
}
