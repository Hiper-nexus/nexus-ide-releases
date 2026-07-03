import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  NOTE_CHANNELS,
  listNotesSchema,
  removeNoteSchema,
  saveNoteSchema,
  type NotesChangedEvent,
} from '../../shared/note-types';
import { getDb } from './db';
import {
  initNotesStore,
  listNotes,
  onNotesChange,
  removeNote,
  saveNote,
} from './notes-store';

/**
 * Renderer-facing IPC for sticky notes. Every boundary is zod-validated —
 * agent-written notes flow through the same channels as user edits, so a
 * malformed payload (non-finite geometry, oversized text) is rejected here
 * and can never corrupt the store. Broadcast pattern mirrors account-ipc.ts.
 */

const listeners = new Set<WebContents>();

function broadcast(workspacePath: string): void {
  const event: NotesChangedEvent = {
    workspacePath,
    notes: listNotes(workspacePath),
  };
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(NOTE_CHANNELS.changed, event);
  }
}

export function registerNotesListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterNotesListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function registerNotesIpc(): void {
  initNotesStore(getDb());
  onNotesChange(broadcast);

  ipcMain.handle(NOTE_CHANNELS.list, (_e, raw) => {
    const parsed = listNotesSchema.safeParse(raw);
    if (!parsed.success) return [];
    return listNotes(parsed.data.workspacePath);
  });

  ipcMain.handle(NOTE_CHANNELS.save, (_e, raw) => {
    const parsed = saveNoteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid note' };
    saveNote(parsed.data.workspacePath, parsed.data.note);
    return { ok: true };
  });

  ipcMain.handle(NOTE_CHANNELS.remove, (_e, raw) => {
    const parsed = removeNoteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    removeNote(parsed.data.id);
    return { ok: true };
  });
}
