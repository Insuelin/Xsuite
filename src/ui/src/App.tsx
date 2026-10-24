import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeEvents, type Overview } from './api.ts';
import { Badge, Bar, fmtAgo, fmtNum } from './components.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { DirectoryPage } from './pages/Directory.tsx';
import { ChangesPage } from './pages/Changes.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { PluginsPage } from './pages/Plugins.tsx';
import type { ServerEvent } from '../../shared/domain.ts';

const PAGES = [
  { key: 'overview', label: '概览' },
  { key: 'directory', label: '名单' },
  { key: 'changes', label: '变化' },
  { key: 'queue', label: '队列' },
  { key: 'plugins', label: '插件' },
  { key: 'settings', label: '设置' },
] as const;

type PageKey = (typeof PAGES)[number]['key'];

function readHash(): PageKey {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES.find((p) => p.key === h)?.key ?? 'overview') as PageKey;
}

function describe(e: ServerEvent): string {
  switch (e.type) {
    case 'scrape:progress':
      return `抓取 ${e.kind}：滚了 ${e.page} 次，${e.items} 人`;
    case 'scrape:done':
      return `抓取 ${e.kind} 完成：${e.items} 人${e.complete ? '' : '（不完整）'}`;
    case 'action:executed':
      return `#${e.actionId} ${e.kind} ${e.ok ? '成功' : `失败 ${e.error ?? ''}`}`;
    case 'queue:progress':
      return `队列 待批${e.pending} 已批${e.approved} 完成${e.done} 失败${e.failed}`;
    case 'cdp:circuit_break':
      return `⚠ ${e.reason}`;
    case 'cdp:state':
      return { idle: '空闲', scraping: '正在抓取', acting: '正在执行', paused: '已暂停' }[e.state];
    default:
      return '未知事件';
  }
}

export default function App() {
  const [page, setPage] = useState<PageKey>(readHash);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [clock, setClock] = useState(0);
  const dataRef = useRef<Overview | null>(null);
  dataRef.current = data;

  const refresh = useCallback(async () => {
    try {
      setData(await api.overview());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(
    () =>
      subscribeEvents((e) => {
        setLog((prev) => [`${new Date().toLocaleTimeString()}  ${describe(e)}`, ...prev].slice(0, 40));
        setClock((n) => n + 1);
        if (e.type !== 'scrape:progress') void refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    const onHash = () => setPage(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (k: PageKey) => {
    location.hash = `#/${k}`;
    setPage(k);
  };

  const job = data?.job ?? null;
  const body = useMemo(() => {
    if (!data) return <div className="p-10 text-sm text-ink-400">正在读取本地数据库……</div>;
    switch (page) {
      case 'directory':
        return <DirectoryPage data={data} refresh={refresh} />;
      case 'changes':
        return <ChangesPage />;
      case 'queue':
        return <QueuePage data={data} refresh={refresh} />;
      case 'plugins':
        return <PluginsPage refresh={refresh} />;
      case 'settings':
        return <SettingsPage data={data} refresh={refresh} />;
      default:
        return <OverviewPage data={data} refresh={refresh} log={log} tick={clock} />;
    }
  }, [data, page, refresh, log, clock]);

  return (
    <div className="flex h-full flex-col bg-ink-50 text-ink-800 md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-ink-200 bg-white md:w-48 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-ink-800 text-xs font-bold text-white">
            X
          </div>
          <div>
            <div className="text-sm font-semibold leading-none">xsuite</div>
            <div className="mt-1 text-[11px] leading-none text-ink-400">
              {data ? `@${data.account.handle}` : '未连接'}
            </div>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0">
          {PAGES.map((p) => (
            <button
              key={p.key}
              onClick={() => go(p.key)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === p.key
                  ? 'bg-ink-100 font-medium text-ink-900'
                  : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
              }`}
            >
              {p.label}
              {p.key === 'queue' && data && data.queue.pending > 0 && (
                <span className="ml-2 rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold text-white">
                  {data.queue.pending}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="mt-auto hidden px-4 pb-4 text-[11px] leading-relaxed text-ink-400 md:block">
          {data?.dryRun ? (
            <Badge tone="amber">全局 dry-run</Badge>
          ) : (
            <span>本地数据 · 操作需人工批准</span>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-ink-200 bg-white px-5 py-2.5">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                job ? 'animate-pulse bg-violet-500' : 'bg-emerald-500'
              }`}
            />
            <span className="text-ink-600">{job ? job.label : '空闲'}</span>
            {job && <span className="text-ink-400">开始于 {fmtAgo(job.startedAt)}</span>}
          </div>

          {data && (
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <span className="tabular-nums">今日取关 {data.quota.today}/{data.quota.perDay}</span>
              <div className="w-20">
                <Bar value={data.quota.today} max={data.quota.perDay} />
              </div>
            </div>
          )}

          {data && (
            <div className="ml-auto flex items-center gap-4 text-xs text-ink-500">
              <span>关注 <b className="tabular-nums text-ink-800">{fmtNum(data.counts.following)}</b></span>
              <span>粉丝 <b className="tabular-nums text-ink-800">{fmtNum(data.counts.followers)}</b></span>
              <span>待批 <b className="tabular-nums text-ink-800">{data.queue.pending}</b></span>
            </div>
          )}
        </header>

        {error && (
          <div className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-700">
            {error} —— 服务没起来？跑 <code className="rounded bg-white px-1">npm run serve</code>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto px-5 py-5">{body}</main>
      </div>
    </div>
  );
}
