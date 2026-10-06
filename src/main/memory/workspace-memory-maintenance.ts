import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PeriodicTaskContext } from '../observability/periodic-task';
import { getWorkspaceMemoryStore } from './workspace-memory';
import { fileLinkTarget } from './memory-links';
import { openWorkspaceFileForRead } from '../orch/workspace-file';

export const SESSION_DIGEST_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_REVISION_BYTES = 1_048_576;

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
    const changed: string[] = [];
    const unbound: string[] = [];
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
          else if (stat.size > MAX_REVISION_BYTES) unbound.push(file);
          else {
            const handle = openWorkspaceFileForRead({ ...scope, rootRealPath: root }, target.slice(5));
            try {
              const buffer = Buffer.alloc(MAX_REVISION_BYTES + 1);
              const bytesRead = await ctx.wait(new Promise<number>((resolve, reject) => {
                fs.read(handle.fd, buffer, 0, buffer.length, 0, (error, count) => error ? reject(error) : resolve(count));
              }));
              ctx.assertCurrent();
              if (bytesRead > MAX_REVISION_BYTES || bytesRead !== handle.stat.size) unbound.push(file);
              else {
                const hash = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
                const key = `file-baseline:${createHash('sha256').update(`${row.id}\0${file}`).digest('hex')}`;
                const baseline = store.getMeta(key);
                // This is an observed byte baseline, not factual attestation.
                if (!baseline) store.setMeta(key, hash);
                else if (baseline !== hash) changed.push(file);
              }
            } finally { handle.close(); }
          }
        }
      } catch (error) {
        ctx.assertCurrent();
        // Unreadable/escaped paths are unverified, never evidence of a live file.
        missing.push(file);
      }
      await ctx.checkpoint();
    }
    ctx.assertCurrent();
    const detail = (missing.length ? `File unavailable: ${missing.slice(0, 4).join(', ')}`
      : changed.length ? `File changed since observed baseline: ${changed.slice(0, 4).join(', ')}`
      : unbound.length ? `File revision unavailable (byte limit): ${unbound.slice(0, 4).join(', ')}` : null)?.slice(0, 512) ?? null;
    if (detail && row.reverify !== detail) store.flagMemory(row.id, 'reverify', detail);
    else if (!detail && row.reverify !== null) store.unflagMemory(row.id, 'reverify');
    store.setMeta(cursorKey, row.id);
  }
  ctx.assertCurrent();
  if (rows.length < 16) store.setMeta(cursorKey, '');
}
