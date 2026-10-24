// 名单统计：全部基于本地快照计算，零网络请求。
// 结果是 JSON，存进 stats 表，每次完整快照写一条，形成时间序列。

import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import type { RelationKind } from '../../shared/domain.ts';

export interface StatsPayload {
  itemCount: number;
  expectedTotal: number | null;
  /** 抓到的数量 / 主页显示的总数 */
  completeness: number | null;

  quality: {
    noAvatar: number;
    zeroTweets: number;
    protected: number;
    verified: number;
    blueVerified: number;
    emptyBio: number;
    noLocation: number;
  };

  /** 发推数分桶 */
  tweetBuckets: Record<string, number>;
  /** 关注/粉丝比分桶 */
  ratioBuckets: Record<string, number>;
  /** 注册年份分布 */
  joinedYear: Record<string, number>;
  /** 本地观测到的关系时长（月）分桶 */
  followAgeBuckets: Record<string, number>;
}

interface Row {
  id: string;
  bio: string | null;
  location: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  joined_at: string | null;
  verified: number;
  blue_verified: number;
  has_avatar: number;
  protected: number;
  since: string | null;
}

function tweetBucket(n: number | null): string {
  if (n === null) return 'unknown';
  if (n === 0) return '0';
  if (n < 10) return '1-9';
  if (n < 100) return '10-99';
  if (n < 1000) return '100-999';
  return '1000+';
}

function ratioBucket(following: number | null, followers: number | null): string {
  if (following === null || followers === null) return 'unknown';
  if (followers === 0) return 'no-followers';
  const r = following / followers;
  if (r === 0) return '0';
  if (r < 0.5) return '0-0.5';
  if (r < 2) return '0.5-2';
  if (r < 10) return '2-10';
  return '10+';
}

function ageBucket(since: string | null): string {
  if (!since) return 'unknown';
  const ms = Date.now() - new Date(since).getTime();
  const months = ms / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 1) return '<1m';
  if (months < 6) return '1-6m';
  if (months < 12) return '6-12m';
  if (months < 24) return '1-2y';
  return '2y+';
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function computeStats(
  db: Db,
  snapshotId: number,
  expectedTotal: number | null,
): StatsPayload {
  const rows = db.prepare(`
    SELECT u.id, u.bio, u.location, u.followers, u.following, u.tweets,
           u.joined_at, u.verified, u.blue_verified, u.has_avatar, u.protected,
           r.since
    FROM snapshot_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN relationships r
      ON r.user_id = u.id AND r.kind = 'following' AND r.active = 1
    WHERE m.snapshot_id = ?
  `).all(snapshotId) as Row[];

  const quality = {
    noAvatar: 0,
    zeroTweets: 0,
    protected: 0,
    verified: 0,
    blueVerified: 0,
    emptyBio: 0,
    noLocation: 0,
  };
  const tweetBuckets: Record<string, number> = {};
  const ratioBuckets: Record<string, number> = {};
  const joinedYear: Record<string, number> = {};
  const followAgeBuckets: Record<string, number> = {};

  for (const r of rows) {
    if (r.has_avatar === 0) quality.noAvatar++;
    if (r.tweets === 0) quality.zeroTweets++;
    if (r.protected === 1) quality.protected++;
    if (r.verified === 1) quality.verified++;
    if (r.blue_verified === 1) quality.blueVerified++;
    if (!r.bio || r.bio.trim() === '') quality.emptyBio++;
    if (!r.location || r.location.trim() === '') quality.noLocation++;

    bump(tweetBuckets, tweetBucket(r.tweets));
    bump(ratioBuckets, ratioBucket(r.following, r.followers));
    bump(followAgeBuckets, ageBucket(r.since));

    const year = r.joined_at ? new Date(r.joined_at).getUTCFullYear() : null;
    bump(joinedYear, year ? String(year) : 'unknown');
  }

  const completeness =
    expectedTotal && expectedTotal > 0 ? rows.length / expectedTotal : null;

  return {
    itemCount: rows.length,
    expectedTotal,
    completeness,
    quality,
    tweetBuckets,
    ratioBuckets,
    joinedYear,
    followAgeBuckets,
  };
}

export function saveStats(
  db: Db,
  params: {
    accountId: string;
    snapshotId: number;
    kind: RelationKind;
    payload: StatsPayload;
  },
): void {
  db.prepare(`
    INSERT INTO stats (account_id, snapshot_id, kind, taken_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    params.accountId,
    params.snapshotId,
    params.kind,
    nowIso(),
    JSON.stringify(params.payload),
  );
}
