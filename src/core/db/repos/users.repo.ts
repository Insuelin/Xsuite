// 用户画像读写。

import type { Db } from '../client.ts';
import { nowIso } from '../client.ts';
import type { User, UserStatus } from '../../../shared/domain.ts';

interface UserRow {
  id: string;
  handle: string;
  prev_handles: string | null;
  name: string | null;
  bio: string | null;
  location: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  media_count: number | null;
  joined_at: string | null;
  verified: number;
  has_avatar: number;
  protected: number;
  status: string;
  last_tweet_at: string | null;
  fetched_at: string;
}

function toDomain(r: UserRow): User {
  return {
    id: r.id,
    handle: r.handle,
    prevHandles: r.prev_handles ? JSON.parse(r.prev_handles) : [],
    name: r.name,
    bio: r.bio,
    location: r.location,
    followers: r.followers,
    following: r.following,
    tweets: r.tweets,
    mediaCount: r.media_count,
    joinedAt: r.joined_at,
    verified: r.verified === 1,
    hasAvatar: r.has_avatar === 1,
    protected: r.protected === 1,
    status: (r.status || 'active') as UserStatus,
    lastTweetAt: r.last_tweet_at,
    fetchedAt: r.fetched_at,
  };
}

export class UsersRepo {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 写入或更新用户；handle 变了就把旧的塞进 prev_handles。 */
  upsert(u: Partial<User> & { id: string; handle: string }): void {
    const existing = this.db
      .prepare('SELECT handle, prev_handles FROM users WHERE id = ?')
      .get(u.id) as { handle: string; prev_handles: string | null } | undefined;

    let prev: string[] = existing?.prev_handles ? JSON.parse(existing.prev_handles) : [];
    if (existing && existing.handle !== u.handle && !prev.includes(existing.handle)) {
      prev.push(existing.handle);
    }

    this.db.prepare(`
      INSERT INTO users (
        id, handle, prev_handles, name, bio, location, followers, following,
        tweets, media_count, joined_at, verified, has_avatar, protected,
        status, last_tweet_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        handle = excluded.handle,
        prev_handles = excluded.prev_handles,
        name = excluded.name,
        bio = excluded.bio,
        location = excluded.location,
        followers = excluded.followers,
        following = excluded.following,
        tweets = excluded.tweets,
        media_count = excluded.media_count,
        joined_at = COALESCE(users.joined_at, excluded.joined_at),
        verified = excluded.verified,
        has_avatar = excluded.has_avatar,
        protected = excluded.protected,
        status = excluded.status,
        last_tweet_at = excluded.last_tweet_at,
        fetched_at = excluded.fetched_at
    `).run(
      u.id,
      u.handle,
      JSON.stringify(prev),
      u.name ?? null,
      u.bio ?? null,
      u.location ?? null,
      u.followers ?? null,
      u.following ?? null,
      u.tweets ?? null,
      u.mediaCount ?? null,
      u.joinedAt ?? null,
      u.verified ? 1 : 0,
      u.hasAvatar === false ? 0 : 1,
      u.protected ? 1 : 0,
      u.status ?? 'active',
      u.lastTweetAt ?? null,
      u.fetchedAt ?? nowIso(),
    );
  }

  get(id: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toDomain(r) : null;
  }

  getByHandle(handle: string): User | null {
    const h = handle.replace(/^@/, '');
    const r = this.db.prepare('SELECT * FROM users WHERE handle = ?').get(h) as UserRow | undefined;
    return r ? toDomain(r) : null;
  }

  setStatus(id: string, status: UserStatus): void {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  }

  /** 白名单检查 */
  isWhitelisted(accountId: string, userId: string): boolean {
    const r = this.db
      .prepare('SELECT 1 AS hit FROM whitelist WHERE account_id = ? AND user_id = ?')
      .get(accountId, userId);
    return Boolean(r);
  }

  addToWhitelist(accountId: string, userId: string, note?: string): void {
    this.db.prepare(`
      INSERT INTO whitelist (account_id, user_id, note, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, user_id) DO UPDATE SET note = excluded.note
    `).run(accountId, userId, note ?? null, nowIso());
  }

  removeFromWhitelist(accountId: string, userId: string): void {
    this.db.prepare('DELETE FROM whitelist WHERE account_id = ? AND user_id = ?').run(accountId, userId);
  }
}
