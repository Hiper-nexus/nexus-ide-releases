import type { Db } from './db';
import type { Note } from '../../shared/note-types';

/**
 * Sticky-note registry, per workspace. In-memory map is the source of truth
 * for the running process; SQLite (when available) mirrors it so notes survive
 * restarts — same discipline as account-store.ts. The `notes` table is created
 * here additively (CREATE TABLE IF NOT EXISTS) so db.ts stays untouched.
 */

interface StoredNote {
  workspacePath: string;
  note: Note;
}

const notes = new Map<string, StoredNote>(); // keyed by note id
let db: Db | null = null;

type ChangeListener = (workspacePath: string) => void;
const listeners = new Set<ChangeListener>();

export function onNotesChange(cb: ChangeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(workspacePath: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(workspacePath);
    } catch (err) {
      console.warn('[notes] listener threw:', err);
    }
  }
}

const NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  text           TEXT NOT NULL DEFAULT '',
  x              REAL NOT NULL,
  y              REAL NOT NULL,
  w              REAL NOT NULL,
  h              REAL NOT NULL,
  color          TEXT NOT NULL,
  linked_pane_id TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes (workspace_path);
`;

interface Row {
  id: string;
  workspace_path: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  linked_pane_id: string | null;
}

/** Hydrate the in-memory map from SQLite. Safe to call with null (JSON-less). */
export function initNotesStore(database: Db | null): void {
  db = database;
  notes.clear();
  if (!db) return;
  try {
    db.exec(NOTES_SCHEMA);
    for (const row of db.prepare('SELECT * FROM notes').all() as Row[]) {
      // Defensive re-check: a corrupted row (non-finite / zero-size geometry)
      // must never reach the renderer — Maestri crashed on exactly this.
      if (
        !Number.isFinite(row.x) ||
        !Number.isFinite(row.y) ||
        !Number.isFinite(row.w) ||
        !Number.isFinite(row.h) ||
        row.w <= 0 ||
        row.h <= 0
      ) {
        continue;
      }
      notes.set(row.id, {
        workspacePath: row.workspace_path,
        note: {
          id: row.id,
          text: row.text,
          x: row.x,
          y: row.y,
          w: row.w,
          h: row.h,
          color: row.color as Note['color'],
          linkedPaneId: row.linked_pane_id ?? undefined,
        },
      });
    }
  } catch (err) {
    console.warn('[notes] failed to hydrate:', err);
  }
}

function persist(workspacePath: string, note: Note): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO notes
         (id, workspace_path, text, x, y, w, h, color, linked_pane_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      note.id,
      workspacePath,
      note.text,
      note.x,
      note.y,
      note.w,
      note.h,
      note.color,
      note.linkedPaneId ?? null,
      Date.now(),
    );
  } catch (err) {
    console.warn('[notes] failed to persist:', err);
  }
}

export function listNotes(workspacePath: string): Note[] {
  return [...notes.values()]
    .filter((s) => s.workspacePath === workspacePath)
    .map((s) => s.note);
}

/** Insert-or-update a note in `workspacePath`. Returns the stored copy. */
export function saveNote(workspacePath: string, note: Note): Note {
  const stored: StoredNote = { workspacePath, note: { ...note } };
  notes.set(note.id, stored);
  persist(workspacePath, stored.note);
  emit(workspacePath);
  return stored.note;
}

export function removeNote(id: string): void {
  const existing = notes.get(id);
  if (!existing) return;
  notes.delete(id);
  try {
    db?.prepare('DELETE FROM notes WHERE id = ?').run(id);
  } catch (err) {
    console.warn('[notes] failed to delete row:', err);
  }
  emit(existing.workspacePath);
}
