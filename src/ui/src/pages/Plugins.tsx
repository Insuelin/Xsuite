import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader, fmtAgo } from '../components.tsx';
import { SchemaRenderer, useParams } from '../SchemaRenderer.tsx';
import type { PluginSummary, PluginView } from '../../../shared/plugin.ts';

export function PluginsPage({ refresh }: { refresh: () => Promise<void> }) {
  const [list, setList] = useState<PluginSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<PluginView | null>(null);
  const [params, setParams] = useParams(view?.view ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (id: string, p: Record<string, unknown>) => {
    setBusy(true);
    try {
      const v = await api.pluginView(id, p);
      setView(v);
      setSelected(new Set());
      setMsg(null);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.plugins();
        setList(res.items);
        if (res.items.length > 0) {
          setActive(res.items[0].id);
          await load(res.items[0].id, {});
        }
      } catch (err) {
        setMsg((err as Error).message);
      }
    })();
  }, [load]);

  const pick = (id: string) => {
    setActive(id);
    void load(id, {});
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = (ids: string[]) =>
    setSelected((prev) => (ids.every((id) => prev.has(id)) ? new Set() : new Set(ids)));

  async function propose() {
    if (!active || selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.pluginPropose(active, [...selected], view?.proposeReason);
      setMsg(`已提报 ${res.added} 条到待批准队列${res.skipped > 0 ? `，${res.skipped} 人在白名单里被跳过` : ''}`);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="插件" desc="插件只能提报，批准和执行仍然要你来点">
        {selected.size > 0 && (
          <Button variant="primary" onClick={() => void propose()} disabled={busy}>
            提报选中（{selected.size}）
          </Button>
        )}
      </PageHeader>

      {list.length === 0 ? (
        <Card>
          <Empty>plugins/ 目录下没有插件</Empty>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-[200px_1fr]">
          <Card className="h-fit">
            <ul className="space-y-1">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => pick(p.id)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      active === p.id
                        ? 'bg-ink-100 font-medium text-ink-900'
                        : 'text-ink-600 hover:bg-ink-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{p.name}</span>
                      <Badge tone="gray">v{p.version}</Badge>
                    </div>
                    {p.description && (
                      <p className="mt-1 text-[11px] font-normal leading-relaxed text-ink-400">
                        {p.description}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            {msg && (
              <div className="mb-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{msg}</div>
            )}
            {busy && !view && <Empty>加载中……</Empty>}
            {view && (
              <SchemaRenderer
                view={view.view}
                ctx={{
                  params,
                  setParam: (k, v) => setParams((prev) => ({ ...prev, [k]: v })),
                  onSubmit: () => active && void load(active, params),
                  selected,
                  toggle,
                  toggleAll,
                }}
              />
            )}
            {view && !view.proposable && (
              <p className="mt-4 text-[11px] text-ink-400">
                这个插件没有可提报的内容。{fmtAgo(new Date().toISOString())} 刷新过。
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
