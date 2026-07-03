import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  Note,
  NoteColor,
  NotesApi,
  NotesChangedEvent,
} from '../../shared/note-types';
import { NOTE_COLORS } from '../../shared/note-types';
import { getActiveWorkspacePath } from './active-workspace';

/**
 * Renderer mirror of the sticky-note store (per-workspace), same shape as
 * provider-store.ts: zustand state + a controller hook that hydrates and
 * subscribes to main-process broadcasts.
 */

function notesApi(): NotesApi {
  return window.nexus.notes;
}

let counter = 0;
function makeNoteId(): string {
  return `note-${Date.now().toString(36)}-${(++counter).toString(36)}`;
}

const DEFAULT_NOTE_SIZE = { w: 220, h: 180 };

interface NotesStore {
  /** Notes of the ACTIVE workspace only. */
  notes: Note[];
  hydrate(): Promise<void>;
  receive(event: NotesChangedEvent): void;
  /** Create a note at canvas coordinates; returns the optimistic copy. */
  addNote(x: number, y: number, color?: NoteColor): Note | null;
  /** Merge a patch into a note and persist it. */
  updateNote(id: string, patch: Partial<Omit<Note, 'id'>>): void;
  removeNote(id: string): void;
}

export const useNotesStore = create<NotesStore>((set, get) => ({
  notes: [],

  hydrate: async () => {
    const workspacePath = getActiveWorkspacePath();
    if (!workspacePath) {
      set({ notes: [] });
      return;
    }
    try {
      set({ notes: await notesApi().list(workspacePath) });
    } catch (err) {
      console.warn('[notes] hydrate failed:', err);
    }
  },

  receive: (event) => {
    // Broadcasts carry the workspace they belong to — ignore other workspaces.
    if (event.workspacePath !== getActiveWorkspacePath()) return;
    set({ notes: event.notes });
  },

  addNote: (x, y, color = NOTE_COLORS[0]) => {
    const workspacePath = getActiveWorkspacePath();
    if (!workspacePath) return null;
    const note: Note = {
      id: makeNoteId(),
      text: '',
      x,
      y,
      w: DEFAULT_NOTE_SIZE.w,
      h: DEFAULT_NOTE_SIZE.h,
      color,
    };
    // Optimistic insert; the `changed` broadcast will reconcile.
    set({ notes: [...get().notes, note] });
    void notesApi().save(workspacePath, note);
    return note;
  },

  updateNote: (id, patch) => {
    const workspacePath = getActiveWorkspacePath();
    if (!workspacePath) return;
    const existing = get().notes.find((n) => n.id === id);
    if (!existing) return;
    const next: Note = { ...existing, ...patch, id };
    set({ notes: get().notes.map((n) => (n.id === id ? next : n)) });
    void notesApi().save(workspacePath, next);
  },

  removeNote: (id) => {
    set({ notes: get().notes.filter((n) => n.id !== id) });
    void notesApi().remove(id);
  },
}));

/**
 * Mount once (e.g. in App) — hydrates for the active workspace and keeps the
 * mirror in sync with main-process broadcasts. Re-run hydrate on workspace
 * change by keying the caller on the workspace path.
 */
export function useNotesController(): void {
  const hydrate = useNotesStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return notesApi().onChanged((event) =>
      useNotesStore.getState().receive(event),
    );
  }, [hydrate]);
}
