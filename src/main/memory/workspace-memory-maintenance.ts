import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PeriodicTaskContext } from '../observability/periodic-task';
import { getWorkspaceMemoryStore } from './workspace-memory';
import { fileLinkTarget } from './memory-links';

export const SESSION_DIGEST_TTL_MS = 30 * 24 * 60 * 60_000;

/** Bounded pass; cursors live in SQLite so restart does not starve later facts. */
export async function maintainWorkspaceMemory(scope: ProjectExecutionScope, ctx: PeriodicTaskContext): Promise<void> {
  ctx.assertCurrent();
  const store = getWorkspaceMemoryStore(scope);
  store.indexHistoricalLinksBatch();
  store.expireUnrecalledSessionDigests(SESSION_DIGEST_TTL_MS);
  await ctx.checkpoint();
  // Only the Main-bound coordinator may define the files used for re-verification.
  const root = store.workspaceRoot;
  if (!root) return;
  const cursorKey = 'maintenance:file-facts-cursor';
  const rows = store.fileLinkedFactPage(store.getMeta(cursorKey) ?? '');
  for (const row of rows) {
    const missing: string[] = [];
    for (const file of row.files) {
      ctx.assertCurrent();
      const target = fileLinkTarget(file);
      if (!target) { missing.push(file); continue; }
      const absolute = path.resolve(root, target.slice(5));
      try {
        const real = await ctx.wait(fs.promises.realpath(absolute));
        const relative = path.relative(root, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) missing.push(file);
        else {
          const stat = await ctx.wait(fs.promises.stat(real));
          if (!stat.isFile()) missing.push(file);
        }
      } catch (error) {
        ctx.assertCurrent();
        // Unreadable/escaped paths are unverified, never evidence of a live file.
        missing.push(file);
      }
      await ctx.checkpoint();
    }
    ctx.assertCurrent();
    const detail = missing.length ? `File unavailable: ${missing.slice(0, 4).join(', ')}`.slice(0, 512) : null;
    if (detail && row.reverify !== detail) store.flagMemory(row.id, 'reverify', detail);
    else if (!detail && row.reverify !== null) store.unflagMemory(row.id, 'reverify');
    store.setMeta(cursorKey, row.id);
  }
  ctx.assertCurrent();
  if (rows.length < 16) store.setMeta(cursorKey, '');
}
