import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { WorkspaceLayout } from '../../shared/types';
import { workspaceLayoutSchema } from '../../shared/ipc';
import { getDb } from './db';

/**
 * Persists the pane layout. A JSON file in userData is the source of truth this
 * phase; a best-effort mirror is written into SQLite so the schema stays warm
 * for later phases.
 */

const WORKSPACE_ID = 1;

function layoutFile(): string {
  return path.join(app.getPath('userData'), 'nexus-layout.json');
}

export function saveLayout(layout: WorkspaceLayout): { ok: boolean } {
  const json = JSON.stringify(layout);

  try {
    fs.writeFileSync(layoutFile(), json, 'utf8');
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

export function loadLayout(): WorkspaceLayout | null {
  let raw: string;
  try {
    raw = fs.readFileSync(layoutFile(), 'utf8');
  } catch {
    return null; // First run — no saved layout.
  }

  try {
    const parsed = workspaceLayoutSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
