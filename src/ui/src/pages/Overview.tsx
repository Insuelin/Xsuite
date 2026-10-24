import { useState } from 'react';
import { api, type Overview } from '../api.ts';
import { Bar, Badge, Button, Card, Empty, PageHeader, Stat, fmtAgo, fmtNum } from '../components.tsx';
import type { RelationKind } from '../../../shared/domain.ts';

const KIND_LABEL: Record<RelationKind, string> = {
  following: '我关注的人',
  followers: '粉丝',
  muted: '已屏蔽',
  blocked: '已拉黑',
};

export function OverviewPage({
  data,
  refresh,
  log,
}: {
  data: Overview;
  refresh: () => Promise<void>;
  log: string[];
  tick: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const scrape = (kind: RelationKind) =>
    run(`scrape-${kind}`, () => api.startScrape(kind), `已开始抓取${KIND_LABEL[kind]}`);

  const act = (confirm: boolean) =>
    run(
      confirm ? 'act-real' : 'act-dry',
      () => api.startActions({ confirm, limit: undefined }),
      confirm ? '已开始真实执行' : '已开始演练',
    );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="概览" desc="所有数据都存在本地，抓取和操作都在你的浏览器里发生">
        {data.job && (
          <Button variant="danger" onClick={() => run('stop', () => api.stop(), '已请求停止')}>
            停止当前任务
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="关注" value={fmtNum(data.counts.following)} hint="当前仍在关注" />
        <Stat label="粉丝" value={fmtNum(data.counts.followers)} hint="当前仍在关注你" />
        <Stat label="用户画像" value={fmtNum(data.counts.users)} hint="本地累计记录" />
        <Stat label="白名单" value={fmtNum(data.counts.whitelist)} hint="永远不会被自动处理" />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Card title="抓取" hint="滚动页面，被动截获 X 自己发出的请求" className="md:col-span-2">
          <div className="flex flex-wrap gap-2">
            {(['following', 'followers', 'muted', 'blocked'] as RelationKind[]).map((k) => (
              <Button
                key={k}
                onClick={() => scrape(k)}
                disabled={busy !== null || data.job !== null}
                variant={k === 'following' ? 'primary' : 'ghost'}
              >
                {busy === `scrape-${k}` ? '启动中…' : `抓取${KIND_LABEL[k]}`}
              </Button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            {(['following', 'followers', 'muted', 'blocked'] as RelationKind[]).map((k) => {
              const s = data.snapshots[k];
              return (
                <div key={k} className="rounded-lg border border-ink-100 px-3 py-2">
                  <div className="text-ink-400">{KIND_LABEL[k]}</div>
                  <div className="mt-1 font-medium tabular-nums text-ink-800">
                    {s ? fmtNum(s.item_count) : '—'}
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-400">
                    {s ? `${fmtAgo(s.taken_at)}${s.complete ? '' : ' · 不完整'}` : '还没抓过'}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="队列">
          <div className="space-y-2 text-xs">
            {(
              [
                ['pending', '待批准'],
                ['approved', '已批准'],
                ['running', '执行中'],
                ['done', '已完成'],
                ['failed', '失败'],
                ['skipped', '已跳过'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-ink-500">{label}</span>
                <span className="tabular-nums font-medium text-ink-800">{data.queue[k]}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-2">
            <div className="text-[11px] text-ink-400">
              今日取关 {data.quota.today}/{data.quota.perDay}
            </div>
            <Bar value={data.quota.today} max={data.quota.perDay} />
            <div className="text-[11px] text-ink-400">
              最近一小时 {data.quota.lastHour}/{data.quota.perHour}
            </div>
            <Bar value={data.quota.lastHour} max={data.quota.perHour} tone="emerald" />
          </div>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card title="执行" hint="8–15 秒一条，连续失败会自动停">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act(false)} disabled={busy !== null || !!data.job}>
              演练一次
            </Button>
            <Button
              variant="danger"
              disabled={busy !== null || !!data.job || data.queue.approved === 0}
              onClick={() => {
                if (confirm(`真的要取关这 ${data.queue.approved} 个人吗？这一步不可撤销。`)) act(true);
              }}
            >
              真实执行（{data.queue.approved} 条）
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
            演练会打开每个人的主页、找到按钮并截图，但不会点击。本地关系和配额都不变。
          </p>
          {msg && <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{msg}</div>}
        </Card>

        <Card title="最近事件" hint="服务端推送">
          {log.length === 0 ? (
            <Empty>还没有事件。抓取或执行的时候会实时出现在这里。</Empty>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-auto text-[11px] leading-relaxed text-ink-500">
              {log.map((line, i) => (
                <li key={i} className="truncate font-mono">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {!data.readiness.ok && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          筛选功能暂时不可用：{data.readiness.problems.join('；')}
        </div>
      )}
      {data.readiness.warnings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.readiness.warnings.map((w) => (
            <Badge key={w} tone="amber">
              {w}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
