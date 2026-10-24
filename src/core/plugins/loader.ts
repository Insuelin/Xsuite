// 插件加载器。插件是普通 ESM 模块，放在 plugins/<id>/index.ts，
// 由 Node 24 直接执行（类型擦除，不需要编译）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import type { PluginManifest, PluginSummary, PluginView } from '../../shared/plugin.ts';

/** 插件能拿到的全部能力。写操作只有 propose，且强制 pending。 */
export interface PluginContext {
  accountId: string;
  db: Db;
  /** 提报到队列。白名单在这里就会被过滤掉，插件无法绕过。 */
  propose(targetIds: string[], reason: string): { added: number; skipped: number };
  whitelisted(userId: string): boolean;
}

export interface PluginModule {
  manifest: PluginManifest;
  run(ctx: PluginContext, params: Record<string, unknown>): Promise<Omit<PluginView, 'manifest'>>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  module: PluginModule;
}

const REQUIRED = ['id', 'name', 'version'] as const;

function assertManifest(m: unknown, dir: string): PluginManifest {
  if (!m || typeof m !== 'object') throw new Error(`${dir}: manifest 不是对象`);
  const obj = m as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (typeof obj[key] !== 'string' || !obj[key]) {
      throw new Error(`${dir}: manifest 缺少 ${key}`);
    }
  }
  return obj as unknown as PluginManifest;
}

function makeContext(db: Db, accountId: string): PluginContext {
  const whitelisted = (userId: string): boolean =>
    Boolean(
      db.prepare('SELECT 1 FROM whitelist WHERE account_id = ? AND user_id = ?').get(accountId, userId),
    );

  return {
    accountId,
    db,
    whitelisted,
    propose(targetIds, reason) {
      const fresh = targetIds.filter((id) => !whitelisted(id));
      const skipped = targetIds.length - fresh.length;
      if (fresh.length === 0) return { added: 0, skipped };

      // 这里不经过 ActionsRepo，直接把状态写死成 pending，
      // 插件没有任何办法把任务推进 approved。
      const exists = db.prepare(`
        SELECT 1 FROM actions
        WHERE account_id = ? AND kind = 'unfollow' AND target_id = ?
          AND status IN ('pending', 'approved', 'running')
      `);
      const insert = db.prepare(`
        INSERT INTO actions (account_id, kind, target_id, status, source, reason, created_at)
        VALUES (?, 'unfollow', ?, 'pending', 'plugin', ?, ?)
      `);

      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of fresh) {
          if (exists.get(accountId, id)) continue;
          insert.run(accountId, id, reason, nowIso());
          added++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { added, skipped };
    },
  };
}

export async function loadPlugins(pluginsDir: string): Promise<LoadedPlugin[]> {
  if (!fs.existsSync(pluginsDir)) return [];

  const out: LoadedPlugin[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const indexPath = path.join(dir, 'index.ts');
    if (!fs.existsSync(indexPath)) continue;

    try {
      const mod = (await import(pathToFileURL(indexPath).href)) as unknown as PluginModule;
      const manifest = assertManifest(mod.manifest, entry.name);
      if (typeof mod.run !== 'function') throw new Error(`${entry.name}: 没有导出 run()`);
      out.push({
        manifest,
        dir,
        module: { ...mod, manifest },
      });
    } catch (err) {
      console.error(`[plugins] 加载 ${entry.name} 失败:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

export function summarize(p: LoadedPlugin): PluginSummary {
  return { ...p.manifest, dir: p.dir };
}

export function contextFor(db: Db, accountId: string): PluginContext {
  return makeContext(db, accountId);
}
