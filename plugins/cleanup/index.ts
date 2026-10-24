// 示例插件：未回关清理。
//
// 它只能 propose，不能批准、不能执行。
// 提报时白名单会被核心再过滤一次，插件绕不过去。

import type { PluginContext } from '../../src/core/plugins/loader.ts';
import type { PluginManifest, PluginView } from '../../src/shared/plugin.ts';
import { checkReadiness, findUnfollowCandidates } from '../../src/core/filter/candidates.ts';

export const manifest: PluginManifest = {
  id: 'cleanup',
  name: '未回关清理',
  description: '关注了很久、没回关你、粉丝也不多的账号，确认后批量提报取关',
  version: '0.1.0',
};

export async function run(
  ctx: PluginContext,
  params: Record<string, unknown>,
): Promise<Omit<PluginView, 'manifest'>> {
  const minDays = Number(params.minDays ?? 0);
  const maxFollowers = Number(params.maxFollowers ?? 5000);
  const excludeProtected = params.excludeProtected !== false;

  const ready = checkReadiness(ctx.db, ctx.accountId);
  if (!ready.ok) {
    return {
      view: {
        type: 'note',
        text: `还筛不了：${ready.problems.join('；')}。先去抓一次关注和粉丝列表。`,
      },
    };
  }

  const candidates = findUnfollowCandidates(ctx.db, ctx.accountId, {
    requireNoFollowBack: true,
    excludeProtected,
    minFollowDays: minDays,
    maxFollowers,
    limit: 300,
  });

  const form = {
    type: 'form' as const,
    submitLabel: '按这些条件重新筛',
    fields: [
      { name: 'minDays', label: '关注至少多少天', type: 'number' as const, default: minDays, hint: '本地从第一次抓取开始记账，刚装的会全是 0' },
      { name: 'maxFollowers', label: '粉丝数不超过', type: 'number' as const, default: maxFollowers },
      { name: 'excludeProtected', label: '排除锁推账号', type: 'switch' as const, default: excludeProtected, hint: '锁推号取关后要对方同意才能再关注' },
    ],
  };

  const stats = {
    type: 'stats' as const,
    items: [
      { label: '符合条件', value: candidates.length, hint: '最多显示 300 条' },
      { label: '关注总数', value: ready.following?.itemCount ?? 0 },
      { label: '粉丝总数', value: ready.followers?.itemCount ?? 0 },
    ],
  };

  const view: PluginView['view'] = {
    type: 'stack',
    children: [
      form,
      stats,
      {
        type: 'table',
        selectKey: 'userId',
        empty: '这个条件下没有找到人',
        columns: [
          { key: 'handle', label: '用户' },
          { key: 'followers', label: '粉丝', align: 'right' },
          { key: 'tweets', label: '推文', align: 'right' },
          { key: 'days', label: '关注天数', align: 'right' },
          { key: 'since', label: '首次记录' },
        ],
        rows: candidates.map((c) => ({
          userId: c.userId,
          handle: `@${c.handle}`,
          followers: c.followers ?? '—',
          tweets: c.tweets ?? '—',
          days: c.followDays ?? 0,
          since: c.since ? c.since.slice(0, 10) : '—',
        })),
      },
    ],
  };

  return {
    view,
    proposable: candidates.length > 0,
    proposeKind: 'unfollow',
    proposeReason: `未回关清理：关注≥${minDays}天，粉丝≤${maxFollowers}`,
  };
}
