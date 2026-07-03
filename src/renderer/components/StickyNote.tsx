import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NoteColor } from '../../shared/note-types';
import { NOTE_COLORS } from '../../shared/note-types';

/**
 * A single connectable sticky note. Standalone component — NOT mounted
 * anywhere yet; CanvasView integration wraps it in an xyflow node.
 *
 * Interaction contract:
 * - Dragging happens ONLY via the header (.note-drag-handle). When mounted as
 *   an xyflow node pass `dragHandle: '.note-drag-handle'` on the node and OMIT
 *   `onMove` — xyflow owns the drag. Standalone (no xyflow), pass `onMove` and
 *   the header runs its own pointer-capture drag.
 * - The textarea and buttons carry the `nodrag` class (xyflow's opt-out) and
 *   stop pointer-down propagation, so typing or picking a color never starts
 *   a canvas drag — the focus-stealing bug class Maestri patched repeatedly.
 * - Text commits are debounced (blur or 500 ms idle) so each keystroke does
 *   not hit SQLite.
 */

const TEXT_COMMIT_DELAY_MS = 500;

export interface StickyNoteProps {
  note: Note;
  /** Persist a partial update (text, color, position…). */
  onChange: (patch: Partial<Omit<Note, 'id'>>) => void;
  onRemove: () => void;
  /**
   * Standalone drag callback (absolute canvas coords). Omit when the parent
   * (xyflow) owns dragging via `dragHandle: '.note-drag-handle'`.
   */
  onMove?: (x: number, y: number) => void;
}

export function StickyNote({ note, onChange, onRemove, onMove }: StickyNoteProps) {
  const [draft, setDraft] = useState(note.text);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // External update (another window / an agent wrote the note) → adopt it,
  // but never clobber an in-flight local edit.
  useEffect(() => {
    if (commitTimer.current === null) setDraft(note.text);
  }, [note.text]);

  const commitText = useCallback(() => {
    if (commitTimer.current !== null) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    if (draftRef.current !== note.text) onChange({ text: draftRef.current });
  }, [note.text, onChange]);

  const handleTextChange = (value: string) => {
    setDraft(value);
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      commitText();
    }, TEXT_COMMIT_DELAY_MS);
  };

  // Flush pending text on unmount so a quick note-then-close is never lost.
  useEffect(() => {
    return () => {
      if (commitTimer.current !== null) {
        clearTimeout(commitTimer.current);
        commitTimer.current = null;
        commitText();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onMove || e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = note.x;
    const originY = note.y;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const handleMove = (ev: PointerEvent) => {
      onMove(originX + (ev.clientX - startX), originY + (ev.clientY - startY));
    };
    const handleUp = () => {
      target.removeEventListener('pointermove', handleMove);
      target.removeEventListener('pointerup', handleUp);
      target.removeEventListener('pointercancel', handleUp);
    };
    target.addEventListener('pointermove', handleMove);
    target.addEventListener('pointerup', handleUp);
    target.addEventListener('pointercancel', handleUp);
  };

  return (
    <div
      className={`note note--${note.color}${note.linkedPaneId ? ' note--linked' : ''}`}
      style={{ width: note.w, height: note.h }}
    >
      <div
        className="note-drag-handle"
        onPointerDown={handleHeaderPointerDown}
        role="toolbar"
        aria-label="Nota adesiva"
      >
        <div className="note-colors nodrag" onPointerDown={(e) => e.stopPropagation()}>
          {NOTE_COLORS.map((color: NoteColor) => (
            <button
              key={color}
              type="button"
              className={`note-color-swatch note-color-swatch--${color}${
                color === note.color ? ' is-active' : ''
              }`}
              aria-label={`Cor ${color}`}
              aria-pressed={color === note.color}
              onClick={() => onChange({ color })}
            />
          ))}
        </div>
        {note.linkedPaneId && (
          <span className="note-link-badge" title={`Conectada ao pane ${note.linkedPaneId}`}>
            ⛓
          </span>
        )}
        <button
          type="button"
          className="note-remove nodrag"
          aria-label="Remover nota"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <textarea
        className="note-text nodrag"
        value={draft}
        placeholder="Escreva algo…"
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => handleTextChange(e.target.value)}
        onBlur={commitText}
      />
    </div>
  );
}
