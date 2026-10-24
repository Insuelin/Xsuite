import { useCallback, useEffect, useState } from 'react';
import { api, type Overview, type WhitelistItem } from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader, fmtTime } from '../components.tsx';

export function SettingsPage({ data, refresh }: { data: Overview; refresh: () => Promise<void> }) {
  const [items, setItems] = useState<WhitelistItem[]>([]);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.whitelist()).items);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const v = input.trim();
    if (!v) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.whitelistAdd({ handle: v.replace(/^@/, '') });
      setInput('');
      setMsg(`已加入白名单：@${v.replace(/^@/, '')}`);
      await load();
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    try {
      await api.whitelistRemove(userId);
      await load();
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="设置" desc="白名单和限速参数" />

      <Card
        title="白名单"
        hint="名单里的人永远不会被筛选、提报或执行，提报和执行时各拦一次"
        className="mb-3"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="输入用户名，例如 jack"
            className="w-64 rounded-lg border border-ink-200 px-3 py-1.5 text-xs outline-none focus:border-ink-400"
          />
          <Button variant="primary" onClick={() => void add()} disabled={busy || !input.trim()}>
            加入
          </Button>
          {msg && <span className="text-xs text-ink-500">{msg}</span>}
        </div>

        {items.length === 0 ? (
          <Empty>白名单是空的</Empty>
        ) : (
          <ul className="divide-y divide-ink-50 text-xs">
            {items.map((w) => (
              <li key={w.userId} className="flex items-center gap-3 py-2">
                <span className="font-medium text-ink-800">
                  {w.handle ? `@${w.handle}` : w.userId}
                </span>
                {w.name && <span className="text-ink-400">{w.name}</span>}
                <span className="ml-auto text-[11px] text-ink-400">{fmtTime(w.createdAt)}</span>
                <button
                  onClick={() => void remove(w.userId)}
                  disabled={busy}
                  className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-rose-50 hover:text-rose-600"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="限速" hint="改这些要动环境变量，界面上只读" className="mb-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-3">
          {[
            ['每日上限', `${data.quota.perDay} 条`],
            ['每小时上限', `${data.quota.perHour} 条`],
            ['今日已用', `${data.quota.today} 条`],
            ['间隔', '8–15 秒'],
            ['连续失败熔断', '5 条'],
            ['每批休息', '25 条后停 3 分钟'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-ink-50 py-1">
              <dt className="text-ink-400">{k}</dt>
              <dd className="tabular-nums text-ink-700">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="关于">
        <div className="space-y-2 text-xs leading-relaxed text-ink-500">
          <p>
            所有抓取都由你的 Edge 页面自己发请求，程序只负责滚动和被动接收响应，
            不会伪造接口调用。
          </p>
          <p>
            写操作通过 CDP 在页面里模拟点击，坐标和事件都发生在页面内部，
            系统鼠标不会动，但 X 看到的就是一次真实点击。
          </p>
          <p className="flex items-center gap-2">
            当前模式：
            {data.dryRun ? <Badge tone="amber">全局 dry-run</Badge> : <Badge tone="emerald">正常</Badge>}
          </p>
        </div>
      </Card>
    </div>
  );
}
