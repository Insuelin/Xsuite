// 声明式视图渲染器：插件返回 JSON，这里变成界面。
// 支持 stats / table / form / note / stack 五种节点。

import { useEffect, useState, type ReactNode } from 'react';
import type { FormField, ViewNode } from '../../shared/plugin.ts';
import { Button, Empty, Stat, fmtNum } from './components.tsx';

export interface RenderCtx {
  params: Record<string, unknown>;
  setParam: (key: string, value: unknown) => void;
  onSubmit: () => void;
  selected: Set<string>;
  toggle: (id: string) => void;
  toggleAll: (ids: string[]) => void;
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputClass =
    'w-40 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs outline-none focus:border-ink-400';

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink-500">{field.label}</span>
      {field.type === 'switch' ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-ink-800"
        />
      ) : field.type === 'select' ? (
        <select className={inputClass} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={inputClass}
          type={field.type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        />
      )}
      {field.hint && <span className="text-[11px] text-ink-400">{field.hint}</span>}
    </label>
  );
}

function renderNode(node: ViewNode, ctx: RenderCtx, key?: string): ReactNode {
  switch (node.type) {
    case 'note':
      return (
        <div key={key} className="rounded-lg bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-600">
          {node.text}
        </div>
      );

    case 'stats':
      return (
        <div key={key} className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {node.items.map((s) => (
            <Stat
              key={s.label}
              label={s.label}
              value={typeof s.value === 'number' ? fmtNum(s.value) : s.value}
              hint={s.hint}
            />
          ))}
        </div>
      );

    case 'form':
      return (
        <div key={key} className="flex flex-wrap items-end gap-4 rounded-lg border border-ink-100 px-3 py-3">
          {node.fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={ctx.params[f.name] ?? f.default}
              onChange={(v) => ctx.setParam(f.name, v)}
            />
          ))}
          <Button variant="primary" onClick={ctx.onSubmit}>
            {node.submitLabel ?? '应用'}
          </Button>
        </div>
      );

    case 'table': {
      const keyName = node.selectKey;
      const ids = node.rows.map((r) => String(r[keyName ?? 'id'] ?? ''));
      const allSelected = ids.length > 0 && ids.every((id) => ctx.selected.has(id));

      if (node.rows.length === 0) return <Empty key={key}>{node.empty ?? '没有数据'}</Empty>;

      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-100 text-ink-400">
              <tr>
                {keyName && (
                  <th className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => ctx.toggleAll(ids)}
                      className="accent-ink-800"
                    />
                  </th>
                )}
                {node.columns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-2 py-2 font-normal ${c.align === 'right' ? 'text-right' : ''}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => {
                const id = String(row[keyName ?? 'id'] ?? i);
                return (
                  <tr key={id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60">
                    {keyName && (
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={ctx.selected.has(id)}
                          onChange={() => ctx.toggle(id)}
                          className="accent-ink-800"
                        />
                      </td>
                    )}
                    {node.columns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-2 py-1.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${
                          c.key === 'handle' ? 'font-medium text-ink-800' : 'text-ink-600'
                        }`}
                      >
                        {String(row[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    case 'stack':
      return (
        <div key={key} className="space-y-4">
          {node.children.map((child, i) => renderNode(child, ctx, `${key}-${i}`))}
        </div>
      );

    default:
      return null;
  }
}

export function SchemaRenderer({ view, ctx }: { view: ViewNode; ctx: RenderCtx }) {
  return <>{renderNode(view, ctx, 'root')}</>;
}

/** 表单默认值：视图第一次到达时用字段的 default 填一遍。 */
export function initialParams(view: ViewNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (n: ViewNode) => {
    if (n.type === 'form') for (const f of n.fields) out[f.name] = f.default;
    if (n.type === 'stack') n.children.forEach(walk);
  };
  walk(view);
  return out;
}

/** 简单受控表单状态容器 */
export function useParams(view: ViewNode | null) {
  const [params, setParams] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (view) setParams(initialParams(view));
  }, [view]);
  return [params, setParams] as const;
}
