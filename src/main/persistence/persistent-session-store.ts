import { getDb } from './db';

export interface PersistentPtyRecord {
  workspaceId: string;
  paneId: string;
  tmuxName: string;
  cwd: string;
  createdAt: number;
}

const ID_MAX = 512;

function valid(value: string, max = ID_MAX): string {
  const clean = value.trim();
  if (
    !clean ||
    clean.length > max ||
    /[\u0000-\u001f\u007f]/.test(clean)
  ) {
    throw new Error('invalid persistent pty identity');
  }
  return clean;
}

export function upsertPersistentPty(record: PersistentPtyRecord): boolean {
  const db = getDb();
  if (!db) return false;
  const workspaceId = valid(record.workspaceId);
  const paneId = valid(record.paneId, 256);
  const tmuxName = valid(record.tmuxName, 128);
  const cwd = valid(record.cwd, 4096);
  const createdAt =
    Number.isFinite(record.createdAt) && record.createdAt > 0
      ? Math.floor(record.createdAt)
      : Date.now();
  db.prepare(
    `INSERT INTO persistent_pty_sessions
       (workspace_id, pane_id, tmux_name, cwd, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, pane_id)
     DO UPDATE SET tmux_name = excluded.tmux_name,
                   cwd = excluded.cwd,
                   created_at = excluded.created_at`,
  ).run(workspaceId, paneId, tmuxName, cwd, createdAt);
  return true;
}

export function getPersistentPty(
  workspaceId: string,
  paneId: string,
): PersistentPtyRecord | null {
  const db = getDb();
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT workspace_id, pane_id, tmux_name, cwd, created_at
       FROM persistent_pty_sessions
       WHERE workspace_id = ? AND pane_id = ?`,
    )
    .get(valid(workspaceId), valid(paneId, 256)) as
    | {
        workspace_id: string;
        pane_id: string;
        tmux_name: string;
        cwd: string;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    tmuxName: row.tmux_name,
    cwd: row.cwd,
    createdAt: row.created_at,
  };
}

export function listPersistentPtys(
  workspaceId: string,
): PersistentPtyRecord[] {
  const db = getDb();
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT workspace_id, pane_id, tmux_name, cwd, created_at
       FROM persistent_pty_sessions
       WHERE workspace_id = ?
       ORDER BY created_at ASC`,
    )
    .all(valid(workspaceId)) as Array<{
    workspace_id: string;
    pane_id: string;
    tmux_name: string;
    cwd: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    tmuxName: row.tmux_name,
    cwd: row.cwd,
    createdAt: row.created_at,
  }));
}

export function deletePersistentPty(
  workspaceId: string,
  paneId: string,
): void {
  const db = getDb();
  if (!db) return;
  db.prepare(
    `DELETE FROM persistent_pty_sessions
     WHERE workspace_id = ? AND pane_id = ?`,
  ).run(valid(workspaceId), valid(paneId, 256));
}
