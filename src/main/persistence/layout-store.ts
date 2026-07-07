import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { WorkspaceLayout } from '../../shared/types';
import { workspaceLayoutSchema } from '../../shared/ipc';
import { writeJsonAtomic } from '../util/atomic-write';
import { getDb } from './db';

/**
 * Persists pane layouts PER WORKSPACE (each workspace folder owns its pane
 * arrangement; switching workspaces swaps layouts instead of dragging panes
 * across projects). A JSON map in userData
 * is the source of truth; a best-effort mirror is written into SQLite so the
 * schema stays warm for later phases.
 */

const WORKSPACE_ID = 1;

interface LayoutFileShape {
  byWorkspace: Record<string, unknown>;
}

function layoutFile(): string {
  return path.join(app.getPath('userData'), 'nexus-layout.json');
}

function readAll(): LayoutFileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(layoutFile(), 'utf8'));
    if (raw && typeof raw.byWorkspace === 'object' && raw.byWorkspace) {
      return raw as LayoutFileShape;
    }
  } catch {
    // Missing or legacy single-layout file — start a fresh map.
  }
  return { byWorkspace: {} };
}

export function saveLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
): { ok: boolean } {
  const all = readAll();
  all.byWorkspace[workspacePath] = layout;
  const json = JSON.stringify(all);

  try {
    // Atômico (tmp + rename): crash no meio do write não corrompe o layout.
    writeJsonAtomic(layoutFile(), all);
  } catch (err) {
    console.error('[nexus] failed to persist layout JSON:', err);
    return { ok: false };
  }

  // Best-effort SQLite mirror; never blocks the primary path.
  try {
    const db = getDb();
    db
      ?.prepare(
        `INSERT INTO workspace (id, layout_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json,
                                       updated_at  = excluded.updated_at`,
      )
      .run(WORKSPACE_ID, json, Date.now());
  } catch (err) {
    console.warn('[nexus] SQLite layout mirror failed:', err);
  }

  return { ok: true };
}

export function loadLayout(workspacePath: string): WorkspaceLayout | null {
  const all = readAll();
  const candidate = all.byWorkspace[workspacePath];
  if (!candidate) return null;
  const parsed = workspaceLayoutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
