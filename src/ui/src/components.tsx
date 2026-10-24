import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { ActionStatus } from '../../shared/domain.ts';

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

const TONES = {
  gray: 'bg-ink-100 text-ink-600',
  amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-sky-100 text-sky-700',
  violet: 'bg-violet-100 text-violet-700',
  emerald: 'bg-emerald-100 text-emerald-700',
  red: 'bg-rose-100 text-rose-700',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const STATUS_META: Record<ActionStatus, { label: string; tone: Tone }> = {
  pending: { label: '待批准', tone: 'amber' },
  approved: { label: '已批准', tone: 'blue' },
  running: { label: '执行中', tone: 'violet' },
  done: { label: '完成', tone: 'emerald' },
  failed: { label: '失败', tone: 'red' },
  skipped: { label: '已跳过', tone: 'gray' },
};

export function StatusBadge({ status }: { status: ActionStatus }) {
  const m = STATUS_META[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function Card({
  title,
  hint,
  actions,
  children,
  className = '',
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-ink-200 bg-white ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-800">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-4 py-3">
      <div className="text-xs text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-800">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

const VARIANTS = {
  primary: 'bg-ink-800 text-white hover:bg-ink-700 disabled:bg-ink-300',
  ghost: 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 disabled:text-ink-300',
  danger: 'border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 disabled:text-rose-200',
} as const;

export function Button({
  variant = 'ghost',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Bar({ value, max, tone = 'violet' }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color =
    tone === 'rose' ? 'bg-rose-400' : tone === 'emerald' ? 'bg-emerald-400' : 'bg-violet-400';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-ink-400">{children}</div>;
}

export function PageHeader({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
        {desc && <p className="mt-0.5 text-xs text-ink-400">{desc}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
