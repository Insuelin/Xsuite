// 插件与前端共享的声明式视图类型。
// 插件不写 React，只返回这些 JSON，前端用 SchemaRenderer 渲染。

export interface ViewColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export interface FormField {
  name: string;
  label: string;
  type: 'number' | 'text' | 'switch' | 'select';
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  hint?: string;
}

export type ViewNode =
  | { type: 'stats'; items: { label: string; value: string | number; hint?: string }[] }
  | {
      type: 'table';
      columns: ViewColumn[];
      rows: Record<string, unknown>[];
      selectKey?: string;
      empty?: string;
    }
  | { type: 'note'; text: string }
  | { type: 'form'; fields: FormField[]; submitLabel?: string }
  | { type: 'stack'; children: ViewNode[] };

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
}

/** 插件页面一次渲染需要的全部数据 */
export interface PluginView {
  manifest: PluginManifest;
  view: ViewNode;
  /** 表格是否支持勾选后提报到队列 */
  proposable?: boolean;
  /** 提报时使用的动作类型 */
  proposeKind?: string;
  /** 提报用的理由文案 */
  proposeReason?: string;
}

export interface PluginSummary extends PluginManifest {
  dir: string;
}
