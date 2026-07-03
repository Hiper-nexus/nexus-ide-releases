import { z } from 'zod';

/**
 * Sticky notes on the canvas — shared agent/user scratch surfaces (Maestri-style).
 * Notes are scoped per workspace and may link to a pane so an agent can write
 * into "its" note. Geometry is validated as FINITE and non-degenerate at every
 * boundary: Maestri shipped two separate crash fixes (0.30.10, 0.30.13) for
 * corrupted / zero-size note geometry and non-finite points silently wedging
 * workspace saves — we reject those payloads at the IPC edge instead.
 */

export const NOTE_COLORS = [
  'yellow',
  'blue',
  'green',
  'pink',
  'purple',
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number];

export interface Note {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: NoteColor;
  /** Pane this note is connected to (agent writes here), if any. */
  linkedPaneId?: string;
}

export const NOTE_MIN_SIZE = 80;
export const NOTE_MAX_SIZE = 4000;
export const NOTE_MAX_TEXT = 100_000;

/** Finite, canvas-sane coordinate — rejects NaN/Infinity from a bad drag. */
const coord = z.number().finite().min(-1_000_000).max(1_000_000);

export const noteSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(NOTE_MAX_TEXT),
  x: coord,
  y: coord,
  w: z.number().finite().min(NOTE_MIN_SIZE).max(NOTE_MAX_SIZE),
  h: z.number().finite().min(NOTE_MIN_SIZE).max(NOTE_MAX_SIZE),
  color: z.enum(NOTE_COLORS),
  linkedPaneId: z.string().min(1).max(128).optional(),
});

const workspacePath = z.string().min(1).max(4096);

export const listNotesSchema = z.object({ workspacePath });
export const saveNoteSchema = z.object({ workspacePath, note: noteSchema });
export const removeNoteSchema = z.object({ id: z.string().min(1).max(128) });

export type SaveNoteRequest = z.infer<typeof saveNoteSchema>;

/** Payload of the `changed` broadcast: full snapshot of one workspace. */
export interface NotesChangedEvent {
  workspacePath: string;
  notes: Note[];
}

export const NOTE_CHANNELS = {
  list: 'notes:list',
  save: 'notes:save',
  remove: 'notes:remove',
  changed: 'notes:changed',
} as const;

/**
 * Renderer-facing API surface — add as `notes:` to NexusApi in shared/types.ts
 * and implement in preload.ts (see notes-ipc.ts for the main side).
 */
export interface NotesApi {
  list(workspacePath: string): Promise<Note[]>;
  save(workspacePath: string, note: Note): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean }>;
  onChanged(cb: (event: NotesChangedEvent) => void): () => void;
}
