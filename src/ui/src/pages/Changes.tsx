import { useCallback, useEffect, useState } from 'react';
import { api, type ChangeRow } from '../api.ts';
import { Badge, Button, Card, Empty, PageHeader, fmtTime, type Tone } from '../components.tsx';

const CHANGE_META: Record<string, { label: string; tone: Tone }> = {
  appeared: { label: '出现', tone: 'emerald' },
  disappeared: { label: '消失', tone: 'gray' },
  self_action: { label: '自己操作', tone: 'violet' },
  account_abnormal: { label: '账号异常', tone: 'red' },
};

const KIND_LABEL: Record<string, string> = {
  following: '关注',
  followers: '粉丝',
  muted: '屏蔽',
  blocked: '拉黑',
};

export function ChangesPage() {
  const [rows, setRows] = useState<ChangeRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.changes(200)).items);
      setMsg(null);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="变化" desc="两次完整快照之间多出来或少了的人，以及你自己动过的手">
        <Button onClick={() => void load()}>刷新</Button>
      </PageHeader>

      {msg && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{msg}</div>}

      <Card>
        {rows.length === 0 ? (
          <Empty>还没有变化记录。抓两次以上完整快照后才会有对比。</Empty>
        ) : (
          <ul className="divide-y divide-ink-50">
            {rows.map((r) => {
              const meta = CHANGE_META[r.change] ?? { label: r.change, tone: 'gray' as Tone };
              return (
                <li key={r.id} className="flex items-center gap-3 px-1 py-2 text-xs">
                  <span className="w-16 shrink-0 text-ink-400">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-ink-800">
                      {r.handle ? `@${r.handle}` : r.userId}
                    </span>
                    {r.name && <span className="ml-1.5 text-ink-400">{r.name}</span>}
                  </span>
                  {r.actionId && <span className="text-[11px] text-ink-300">#{r.actionId}</span>}
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-400">
                    {fmtTime(r.detectedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
