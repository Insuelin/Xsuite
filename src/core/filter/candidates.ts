// 本地筛选：全部基于 relationships / users 表，零网络请求。
//
// 安全前提：必须同时存在「完整」的 following 快照和 followers 快照。
// 少了任一份，「没回关」这个判断会把关注列表里的所有人都算进去，
// 一批准就是批量误伤，所以这里先挡住。

import type { Db } from '../db/client.ts';
import type { RelationKind } from '../../shared/domain.ts';

export interface SnapshotInfo {
  id: number;
  itemCount: number;
  takenAt: string;
}

export interface Readiness {
  ok: boolean;
  following: SnapshotInfo | null;
  followers: SnapshotInfo | null;
  problems: string[];
  warnings: string[];
}

export interface CandidateFilter {
  /** 只保留没有回关我的人，默认开 */
  requireNoFollowBack?: boolean;
  /** 排除锁推账号：取关后要对方同意才能再关注，不可逆 */
  excludeProtected?: boolean;
  /** 只看没有头像的 */
  noAvatar?: boolean;
  /** 只看一条推都没发的 */
  zeroTweets?: boolean;
  /** 关注时长至少多少天 */
  minFollowDays?: number;
  /** 粉丝数不超过多少（筛掉大号，避免误伤） */
  maxFollowers?: number;
  /** 最多返回多少条 */
  limit?: number;
}

export interface Candidate {
  userId: string;
  handle: string;
  name: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  hasAvatar: boolean;
  isProtected: boolean;
  since: string | null;
  followsBack: boolean;
  /** 本地观测到的关注时长（天）；第一次抓取之后才有意义 */
  followDays: number | null;
}

function latestComplete(db: Db, accountId: string, kind: RelationKind): SnapshotInfo | null {
  const r = db.prepare(`
    SELECT id, item_count, taken_at FROM snapshots
    WHERE account_id = ? AND kind = ? AND complete = 1
    ORDER BY id DESC LIMIT 1
  `).get(accountId, kind) as { id: number; item_count: number; taken_at: string } | undefined;
  return r ? { id: r.id, itemCount: r.item_count, takenAt: r.taken_at } : null;
}

/** 检查数据是否足够支撑筛选。不 ok 就别往下走。 */
export function checkReadiness(db: Db, accountId: string, staleDays = 14): Readiness {
  const following = latestComplete(db, accountId, 'following');
  const followers = latestComplete(db, accountId, 'followers');
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!following) problems.push('没有完整的「我关注的人」快照');
  if (!followers) problems.push('没有完整的「粉丝」快照');

  const now = Date.now();
  const pairs: [string, SnapshotInfo | null][] = [['关注', following], ['粉丝', followers]];
  for (const [label, s] of pairs) {
    if (s && now - new Date(s.takenAt).getTime() > staleDays * 86_400_000) {
      warnings.push(`${label}快照已超过 ${staleDays} 天`);
    }
  }

  return { ok: problems.length === 0, following, followers, problems, warnings };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * 找出「我关注了但没回关我」的候选。
 * 已经在队列里（pending / approved / running）的人会被排除，避免重复提报。
 */
export function findUnfollowCandidates(
  db: Db,
  accountId: string,
  filter: CandidateFilter = {},
): Candidate[] {
  const opts: Required<Omit<CandidateFilter, 'limit'>> = {
    requireNoFollowBack: filter.requireNoFollowBack ?? true,
    excludeProtected: filter.excludeProtected ?? true,
    noAvatar: filter.noAvatar ?? false,
    zeroTweets: filter.zeroTweets ?? false,
    minFollowDays: filter.minFollowDays ?? 0,
    maxFollowers: filter.maxFollowers ?? Number.MAX_SAFE_INTEGER,
  };

  const rows = db.prepare(`
    SELECT u.id, u.handle, u.name, u.followers, u.following, u.tweets,
           u.has_avatar, u.protected, r.since,
           EXISTS(
             SELECT 1 FROM relationships f
             WHERE f.account_id = r.account_id AND f.user_id = u.id
               AND f.kind = 'followers' AND f.active = 1
           ) AS follows_back
    FROM relationships r
    JOIN users u ON u.id = r.user_id
    WHERE r.account_id = ? AND r.kind = 'following' AND r.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM whitelist w
        WHERE w.account_id = r.account_id AND w.user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM actions a
        WHERE a.account_id = r.account_id AND a.target_id = u.id
          AND a.kind = 'unfollow' AND a.status IN ('pending', 'approved', 'running')
      )
    ORDER BY r.since ASC
  `).all(accountId) as unknown as {
    id: string;
    handle: string;
    name: string | null;
    followers: number | null;
    following: number | null;
    tweets: number | null;
    has_avatar: number;
    protected: number;
    since: string | null;
    follows_back: number;
  }[];

  const out: Candidate[] = [];
  for (const r of rows) {
    const followsBack = r.follows_back === 1;
    const isProtected = r.protected === 1;
    const hasAvatar = r.has_avatar === 1;
    const followDays = daysSince(r.since);

    if (opts.requireNoFollowBack && followsBack) continue;
    if (opts.excludeProtected && isProtected) continue;
    if (opts.noAvatar && hasAvatar) continue;
    if (opts.zeroTweets && r.tweets !== 0) continue;
    if (opts.minFollowDays > 0 && (followDays === null || followDays < opts.minFollowDays)) continue;
    if (r.followers !== null && r.followers > opts.maxFollowers) continue;

    out.push({
      userId: r.id,
      handle: r.handle,
      name: r.name,
      followers: r.followers,
      following: r.following,
      tweets: r.tweets,
      hasAvatar,
      isProtected,
      since: r.since,
      followsBack,
      followDays,
    });

    if (filter.limit && out.length >= filter.limit) break;
  }

  return out;
}

/** 把筛选条件说成人话，用在命令行确认和执行日志里。 */
export function describeFilter(filter: CandidateFilter): string {
  const parts: string[] = [];
  if (filter.requireNoFollowBack ?? true) parts.push('没回关我');
  if (filter.excludeProtected ?? true) parts.push('排除锁推');
  if (filter.noAvatar) parts.push('无头像');
  if (filter.zeroTweets) parts.push('零推文');
  if (filter.minFollowDays) parts.push(`关注≥${filter.minFollowDays}天`);
  if (filter.maxFollowers !== undefined) parts.push(`粉丝≤${filter.maxFollowers}`);
  if (filter.limit) parts.push(`最多 ${filter.limit} 人`);
  return parts.join('，') || '无条件';
}
