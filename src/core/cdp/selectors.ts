// X 页面选择器与 URL 模板的唯一维护点。
// X 改版时只改这个文件；改动后先跑 scripts/phase1-check.ts 的 dry-run 截图确认。

export const URLS = {
  home: 'https://x.com/home',
  userPage: (userId: string) => `https://x.com/i/user/${userId}`,
  following: (handle: string) => `https://x.com/${handle}/following`,
  followers: (handle: string) => `https://x.com/${handle}/followers`,
  muted: 'https://x.com/settings/muted',
  blocked: 'https://x.com/settings/blocked',
  likes: (handle: string) => `https://x.com/${handle}/likes`,
  search: (q: string) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
} as const;

/**
 * 注意：这些值需要实测确认。X 的 testid 会变，改版后先跑 dry-run。
 */
export const SELECTORS = {
  /** 用户主页上的取关按钮 */
  unfollowButton: (userId: string) => `[data-testid="${userId}-unfollow"]`,
  /** 用户主页上的关注按钮（未关注时） */
  followButton: (userId: string) => `[data-testid="${userId}-follow"]`,
  /** 确认弹窗里的「取消关注」 */
  confirmSheetConfirm: '[data-testid="confirmationSheetConfirm"]',
  /** 时间线里的用户卡片 */
  userCell: '[data-testid="UserCell"]',
  /** 页面主体，用于判断是否加载完成 */
  primaryColumn: '[data-testid="primaryColumn"]',
  /** 登录态判断 */
  sideNav: '[data-testid="SideNav_AccountSwitcher_Button"]',
} as const;

/** GraphQL 响应 URL 里用来识别列表类型的片段 */
export const GRAPHQL_MATCHERS = {
  following: /\/graphql\/.*\/Following\b/,
  followers: /\/graphql\/.*\/Followers\b/,
  muted: /\/graphql\/.*\/(Muted|MuteList)\b/,
  blocked: /\/graphql\/.*\/(Blocked|BlockList)\b/,
  userTweets: /\/graphql\/.*\/UserTweets\b/,
  search: /\/graphql\/.*\/SearchTimeline\b/,
} as const;
