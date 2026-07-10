import { z } from 'zod';
import {
  noteSchema,
  type Note,
} from '../../shared/note-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

const noteInputSchema = noteSchema.strict();
const noteIdSchema = noteSchema.shape.id;
const noteRowSchema = z
  .object({
    id: noteSchema.shape.id,
    text: noteSchema.shape.text,
    x: noteSchema.shape.x,
    y: noteSchema.shape.y,
    w: noteSchema.shape.w,
    h: noteSchema.shape.h,
    color: noteSchema.shape.color,
    linked_pane_id: z.string().min(1).max(128).nullable(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type ScopedNote = ScopedEntity<Note>;
export type SaveNoteInput = z.input<typeof noteInputSchema>;

type NoteRow = z.infer<typeof noteRowSchema>;

function cloneNote(note: ScopedNote): ScopedNote {
  return { ...note };
}

export class ScopedNotesStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  list(): ScopedNote[] {
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT id, text, x, y, w, h, color, linked_pane_id, updated_at
         FROM sticky_notes
         ORDER BY updated_at DESC, id ASC`,
      )
      .all();
    return rows.map((row) => this.#fromRow(row));
  }

  save(rawNote: SaveNoteInput): ScopedNote {
    const note = noteInputSchema.parse(rawNote);
    const stored: ScopedNote = {
      ...note,
      ...this.#binding.coordinates,
    };
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO sticky_notes
           (id, text, x, y, w, h, color, linked_pane_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           x = excluded.x,
           y = excluded.y,
           w = excluded.w,
           h = excluded.h,
           color = excluded.color,
           linked_pane_id = excluded.linked_pane_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        stored.id,
        stored.text,
        stored.x,
        stored.y,
        stored.w,
        stored.h,
        stored.color,
        stored.linkedPaneId ?? null,
        this.#binding.now(),
      );
    this.#binding.emitChange();
    return cloneNote(stored);
  }

  remove(rawId: string): boolean {
    const id = noteIdSchema.parse(rawId);
    const result = this.#binding
      .writeDatabase()
      .prepare('DELETE FROM sticky_notes WHERE id = ?')
      .run(id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  #fromRow(rawRow: unknown): ScopedNote {
    let row: NoteRow;
    try {
      row = noteRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('sticky note', { cause: error });
    }
    return {
      id: row.id,
      text: row.text,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      color: row.color,
      ...(row.linked_pane_id === null
        ? {}
        : { linkedPaneId: row.linked_pane_id }),
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedNotesStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedNotesStore {
  return new ScopedNotesStore(runtimeManager, scope, options);
}
