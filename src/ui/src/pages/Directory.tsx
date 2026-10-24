import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Overview, type UserRow } from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader, fmtAgo, fmtNum } from '../components.tsx';
import type { RelationKind } from '../../../shared/domain.ts';

const TABS: { key: RelationKind; label: string }[] = [
  { key: 'following', label: '我关注的' },
  { key: 'followers', label: '粉丝' },
  { key: 'muted', label: '已屏蔽' },
  { key: 'blocked', label: '已拉黑' },
];

const PAGE = 100;

export function DirectoryPage({ data, refresh }: { data: Overview; refresh: () => Promise<void> }) {
  const [kind, setKind] = useState<RelationKind>('following');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [onlyNoFollowBack, setOnlyNoFollowBack] = useState(false);
  const [rows, setRows] = useState<UserRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      setLoading(true);
      try {
        const res = await api.users({
          kind,
          q: debounced,
          filter: onlyNoFollowBack ? 'no-follow-back' : undefined,
          limit: PAGE,
          offset: nextOffset,
        });
        setRows((prev) => (append ? [...prev, ...res.items] : res.items));
        setOffset(nextOffset);
      } catch (err) {
        setMsg((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [kind, debounced, onlyNoFollowBack],
  );

  useEffect(() => {
    setSelected(new Set());
    void load(0, false);
  }, [load]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.userId));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.userId)));
  };

  async function doPropose() {
    if (!data.readiness.ok) {
      setMsg(data.readiness.problems.join('；'));
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const filters = ['following', 'followers'].includes(kind)
        ? { requireNoFollowBack: true, excludeProtected: true }
        : {};
      const res = await api.propose(filters);
      setMsg(`按「${describe(kind, filters)}」提报：候选 ${res.candidates} 人，新增 ${res.added} 条`);
      await refresh();
      void load(0, false);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      let added = 0;
      for (const userId of selected) {
        const res = await api.add({ userId, kind: 'unfollow' });
        added += res.added;
      }
      setMsg(`已把 ${added} 人加入待批准队列`);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function whitelist(userId: string) {
    setBusy(true);
    try {
      await api.whitelistAdd({ userId });
      setMsg('已加入白名单');
      await refresh();
      void load(0, false);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const total = useMemo(
    () => ({ following: data.counts.following, followers: data.counts.followers, muted: data.counts.muted, blocked: data.counts.blocked })[kind],
    [data, kind],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="名单" desc={`本地快照 · 共 ${fmtNum(total)} 人`}>
        <Button variant="primary" onClick={doPropose} disabled={busy}>
          按「没回关我」提报
        </Button>
      </PageHeader>

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-ink-200 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  kind === t.key ? 'bg-ink-800 text-white' : 'text-ink-500 hover:text-ink-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜用户名或昵称"
            className="w-48 rounded-lg border border-ink-200 px-3 py-1.5 text-xs outline-none focus:border-ink-400"
          />

          <label className="flex items-center gap-1.5 text-xs text-ink-500">
            <input
              type="checkbox"
              checked={onlyNoFollowBack}
              onChange={(e) => setOnlyNoFollowBack(e.target.checked)}
              className="accent-ink-800"
            />
            只看没回关我
          </label>

          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-ink-500">已选 {selected.size}</span>
              <Button variant="primary" onClick={addSelected} disabled={busy}>
                加入队列
              </Button>
            </div>
          )}
        </div>

        {msg && <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{msg}</div>}
      </Card>

      <Card className="overflow-hidden" >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-100 text-ink-400">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-ink-800" />
                </th>
                <th className="px-3 py-2 font-normal">用户</th>
                <th className="px-3 py-2 text-right font-normal">粉丝</th>
                <th className="px-3 py-2 text-right font-normal">关注</th>
                <th className="px-3 py-2 text-right font-normal">推文</th>
                <th className="px-3 py-2 font-normal">状态</th>
                <th className="px-3 py-2 font-normal">记录</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.userId)}
                      onChange={() => toggle(r.userId)}
                      className="accent-ink-800"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink-800">@{r.handle}</span>
                      {r.blueVerified && <Badge tone="blue">蓝标</Badge>}
                      {r.protected && <Badge tone="gray">锁推</Badge>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-400">{r.name ?? ''}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-600">{fmtNum(r.followers)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-600">{fmtNum(r.following)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-600">{fmtNum(r.tweets)}</td>
                  <td className="px-3 py-2">
                    {kind === 'followers' ? (
                      <Badge tone="emerald">粉丝</Badge>
                    ) : r.followsBack ? (
                      <Badge tone="emerald">回关</Badge>
                    ) : (
                      <Badge tone="amber">没回关</Badge>
                    )}
                    {r.whitelisted && <span className="ml-1"><Badge tone="violet">白名单</Badge></span>}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-ink-400">{fmtAgo(r.since)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => whitelist(r.userId)}
                      disabled={busy || r.whitelisted}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-40"
                    >
                      白名单
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && !loading && <Empty>这个筛选下没有数据</Empty>}

        <div className="flex items-center justify-between border-t border-ink-100 px-3 py-2 text-[11px] text-ink-400">
          <span>已显示 {rows.length} 人</span>
          {rows.length >= PAGE && (
            <Button onClick={() => void load(offset + PAGE, true)} disabled={loading}>
              {loading ? '加载中…' : '加载更多'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function describe(kind: RelationKind, filters: Record<string, unknown>): string {
  const base = filters.requireNoFollowBack ? '没回关我' : '全部';
  return kind === 'following' ? `${base} · 排除锁推` : base;
}
