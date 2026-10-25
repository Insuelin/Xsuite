// X 页面选择器与 URL 模板的唯一维护点。
// X 改版时只改这个文件；改动后先跑 scripts/phase1-check.ts 的 dry-run 截图确认。

export const URLS = {
  home: 'https://x.com/home',
  userPage: (userId: string) => `https://x.com/i/user/${userId}`,
  following: (handle: string) => `https://x.com/${handle}/following`,
  followers: (handle: string) => `https://x.com/${handle}/followers`,
  muted: 'https://x.com/settings/muted/all',
  blocked: 'https://x.com/settings/blocked/all',
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
  /** 用户主页右上角的「更多」按钮，mute / block 都藏在它展开的菜单里 */
  userActionsMenu: '[data-testid="userActions"]',
  /**
   * 「更多」菜单里的隐藏 / 屏蔽。
   *
   * 注意：这两个 testid 是**变的**。用户被隐藏之后，菜单项仍然是
   * `data-testid="mute"`，只是文字从「隐藏」变成「取消隐藏」。
   * 所以判断状态只能读文字（见 actions.ts 的 MENU_SPEC），
   * 不能指望出现 unmute / unblock 这样的 testid。
   */
  menuMute: '[data-testid="mute"]',
  menuBlock: '[data-testid="block"]',
  /** 菜单容器，用来判断菜单有没有弹出来 */
  menuItem: '[role="menuitem"]',
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
  muted: /\/graphql\/.*\/(MutedAccounts|Muted|MuteList)\b/,
  blocked: /\/graphql\/.*\/(BlockedAccountsAll|Blocked|BlockList)\b/,
  userTweets: /\/graphql\/.*\/UserTweets\b/,
  search: /\/graphql\/.*\/SearchTimeline\b/,
} as const;
