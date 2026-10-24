// 纯函数：把 X 的 GraphQL JSON 转成领域模型。
// 不依赖浏览器，可以拿录制的样本单独跑测试。
//
// 注意：X 在 2026 年把用户对象从 legacy 扁平结构换成了分层结构
// （core / avatar / relationship_counts / tweet_counts / verification / privacy）。
// 这里两套都兼容，灰度或回滚时不至于全挂。

export interface ParsedUser {
  id: string;
  handle: string;
  name: string | null;
  bio: string | null;
  location: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  mediaCount: number | null;
  joinedAt: string | null;
  verified: boolean;
  hasAvatar: boolean;
  protected: boolean;
}

export interface ParsedTimelinePage {
  users: ParsedUser[];
  bottomCursor: string | null;
  topCursor: string | null;
  terminated: boolean;
}

const EMPTY_PAGE: ParsedTimelinePage = {
  users: [],
  bottomCursor: null,
  topCursor: null,
  terminated: false,
};

/** 在任意嵌套里找到第一个 instructions 数组。 */
function findInstructions(node: unknown, depth = 0): unknown[] | null {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.instructions)) return obj.instructions;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findInstructions(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** "Sat Sep 26 15:49:18 +0000 2015" → ISO；解析不了返回 null。 */
export function parseTwitterDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 从 user_results.result 里提取字段，兼容新旧两套结构。 */
export function parseUser(raw: unknown): ParsedUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, any>;

  const id = str(u.rest_id);
  const core = u.core ?? {};
  const legacy = u.legacy ?? {};

  const handle = str(core.screen_name) ?? str(legacy.screen_name);
  if (!id || !handle) return null;

  const bio = u.profile_bio?.description ?? legacy.description ?? null;
  const location = u.location?.location ?? legacy.location ?? null;
  const avatarUrl = u.avatar?.image_url ?? legacy.profile_image_url_https ?? null;

  // X 的默认头像也有 URL，用路径特征识别
  const hasCustomAvatar = Boolean(
    avatarUrl && !String(avatarUrl).includes('/default_profile_images/'),
  );

  // 新结构里认证信息拆成了 verification.verified 和 is_blue_verified 两处
  const verified = Boolean(
    u.verification?.verified || u.is_blue_verified || legacy.verified,
  );

  return {
    id,
    handle,
    name: str(core.name) ?? str(legacy.name),
    bio: typeof bio === 'string' && bio.length > 0 ? bio : null,
    location: typeof location === 'string' && location.length > 0 ? location : null,
    followers: num(u.relationship_counts?.followers) ?? num(legacy.followers_count),
    following: num(u.relationship_counts?.following) ?? num(legacy.friends_count),
    tweets: num(u.tweet_counts?.tweets) ?? num(legacy.statuses_count),
    mediaCount: num(u.tweet_counts?.media_tweets) ?? num(legacy.media_count),
    joinedAt: parseTwitterDate(core.created_at) ?? parseTwitterDate(legacy.created_at),
    verified,
    hasAvatar: hasCustomAvatar,
    protected: Boolean(u.privacy?.protected ?? legacy.protected),
  };
}

/** 解析一页时间线（Following / Followers / Muted / Blocked / UserTweets / Search）。 */
export function parseTimeline(json: unknown): ParsedTimelinePage {
  const instructions = findInstructions(json);
  if (!instructions) return { ...EMPTY_PAGE, users: [] };

  const users: ParsedUser[] = [];
  let bottomCursor: string | null = null;
  let topCursor: string | null = null;
  let terminated = false;

  for (const rawIns of instructions) {
    const ins = rawIns as Record<string, any>;
    if (ins.type === 'TimelineTerminateTimeline') terminated = true;

    if (ins.type !== 'TimelineAddEntries' && ins.type !== 'TimelineReplaceEntry') continue;
    const entries: any[] = ins.entries ?? (ins.entry ? [ins.entry] : []);

    for (const entry of entries) {
      const content = entry?.content;
      if (!content) continue;

      // 游标
      if (content.cursorType) {
        const value = str(content.value);
        if (content.cursorType === 'Bottom') bottomCursor = value;
        if (content.cursorType === 'Top') topCursor = value;
        continue;
      }

      // 用户条目
      const result = content.itemContent?.user_results?.result;
      if (result) {
        const parsed = parseUser(result);
        if (parsed) users.push(parsed);
      }
    }
  }

  return { users, bottomCursor, topCursor, terminated };
}

/** 去重：同一页里可能出现重复用户（置顶、推荐）。 */
export function dedupeUsers(users: ParsedUser[]): ParsedUser[] {
  const seen = new Map<string, ParsedUser>();
  for (const u of users) seen.set(u.id, u);
  return [...seen.values()];
}

/** 列表所属账号（即响应里的 data.user.result），用于完整度校验。 */
export interface TimelineOwner {
  id: string;
  handle: string;
  followers: number | null;
  following: number | null;
}

export function parseTimelineOwner(json: unknown): TimelineOwner | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, any>;
  // 实际结构是 { data: { data: { user: { result } } } }，但有些端点只嵌一层
  const u = root.data?.data?.user?.result ?? root.data?.user?.result;
  if (!u) return null;

  const core = u.core ?? {};
  const legacy = u.legacy ?? {};
  const id = str(u.rest_id);
  const handle = str(core.screen_name) ?? str(legacy.screen_name);
  if (!id || !handle) return null;

  return {
    id,
    handle,
    followers: num(u.relationship_counts?.followers) ?? num(legacy.followers_count),
    following: num(u.relationship_counts?.following) ?? num(legacy.friends_count),
  };
}
