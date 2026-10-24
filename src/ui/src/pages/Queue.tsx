import { useCallback, useEffect, useState } from 'react';
import { api, type Overview, type QueueItem } from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader, StatusBadge, fmtTime } from '../components.tsx';
import type { ActionStatus } from '../../../shared/domain.ts';

const TABS: { key: ActionStatus | 'all'; label: string }[] = [
  { key: 'pending', label: '待批准' },
  { key: 'approved', label: '已批准' },
  { key: 'running', label: '执行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'skipped', label: '已跳过' },
  { key: 'all', label: '全部' },
];

const KIND_LABEL: Record<string, string> = {
  unfollow: '取关',
  follow: '关注',
  mute: '屏蔽',
  unmute: '取消屏蔽',
  block: '拉黑',
  unblock: '取消拉黑',
  delete_tweet: '删推',
  unlike: '取消喜欢',
};

export function QueuePage({ data, refresh }: { data: Overview; refresh: () => Promise<void> }) {
  const [tab, setTab] = useState<ActionStatus | 'all'>('pending');
  const [rows, setRows] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.queue(tab === 'all' ? undefined : tab)).items);
      setSelected(new Set());
    } catch (err) {
      setMsg((err as Error).message);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data.job) void load();
  }, [data.job, load]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  async function act(fn: () => Promise<{ changed: number }>, label: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fn();
      setMsg(`${label} ${res.changed} 条`);
      await refresh();
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const approveSelected = () =>
    act(() => api.approve({ ids: [...selected] }), '批准了');

  const approveAll = () => {
    if (!confirm(`批准全部 ${data.queue.pending} 条待办？批准后就会进入执行队列。`)) return;
    void act(() => api.approve({ all: true }), '批准了');
  };

  const rejectSelected = () =>
    act(() => api.reject({ ids: [...selected] }), '驳回了');

  async function execute(confirmReal: boolean) {
    if (confirmReal && !confirm(`真的要取关 ${data.queue.approved} 个人吗？这一步不可撤销。`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.startActions({ confirm: confirmReal });
      setMsg(confirmReal ? '已开始真实执行' : '已开始演练');
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const canBulk = selectedRows.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="队列" desc="所有写操作先进队列，由你批准后才执行">
        <Button onClick={() => void execute(false)} disabled={busy || !!data.job || data.queue.approved === 0}>
          演练
        </Button>
        <Button
          variant="primary"
          onClick={() => void execute(true)}
          disabled={busy || !!data.job || data.queue.approved === 0}
        >
          执行已批准（{data.queue.approved}）
        </Button>
      </PageHeader>

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-0.5 rounded-lg border border-ink-200 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  tab === t.key ? 'bg-ink-800 text-white' : 'text-ink-500 hover:text-ink-800'
                }`}
              >
                {t.label}
                {t.key === 'pending' && data.queue.pending > 0 && (
                  <span className="ml-1 text-[10px] opacity-70">{data.queue.pending}</span>
                )}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {tab === 'pending' && (
              <Button onClick={approveAll} disabled={busy || data.queue.pending === 0}>
                全部批准
              </Button>
            )}
            {canBulk && tab === 'pending' && (
              <Button variant="primary" onClick={approveSelected} disabled={busy}>
                批准选中（{selected.size}）
              </Button>
            )}
            {canBulk && (tab === 'pending' || tab === 'approved') && (
              <Button variant="danger" onClick={rejectSelected} disabled={busy}>
                驳回选中
              </Button>
            )}
          </div>
        </div>

        {msg && <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{msg}</div>}
      </Card>

      <Card>
        {rows.length === 0 ? (
          <Empty>
            {tab === 'pending' ? '没有待批准的任务。去「名单」页提报一批。' : '这个状态下没有任务'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-ink-100 text-ink-400">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                      }
                      className="accent-ink-800"
                    />
                  </th>
                  <th className="px-3 py-2 font-normal">#</th>
                  <th className="px-3 py-2 font-normal">操作</th>
                  <th className="px-3 py-2 font-normal">目标</th>
                  <th className="px-3 py-2 font-normal">状态</th>
                  <th className="px-3 py-2 font-normal">来源</th>
                  <th className="px-3 py-2 font-normal">执行时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                            return next;
                          })
                        }
                        className="accent-ink-800"
                      />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-ink-400">{r.id}</td>
                    <td className="px-3 py-2 text-ink-700">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink-800">
                        {r.handle ? `@${r.handle}` : r.targetId}
                      </span>
                      {r.error && <span className="ml-2 text-[11px] text-rose-500">{r.error}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status} />
                      {r.dryRun && <span className="ml-1"><Badge tone="amber">演练</Badge></span>}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-ink-400">{r.source ?? '—'}</td>
                    <td className="px-3 py-2 text-[11px] tabular-nums text-ink-400">
                      {fmtTime(r.executedAt ?? r.approvedAt ?? r.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
