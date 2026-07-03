import { Panel, useReactFlow } from '@xyflow/react';
import { useNotesStore } from '../state/notes-store';

/**
 * Creates a sticky note at the center of the current canvas viewport. Must be
 * mounted as a child of <ReactFlow> (it uses the flow context for
 * screenToFlowPosition); it ships its own <Panel> so integration is one line.
 * NOT mounted anywhere yet — CanvasView integration adds it.
 */

/** Mirrors DEFAULT_NOTE_SIZE in state/notes-store.ts (not exported there). */
const NOTE_HALF_W = 110;
const NOTE_HALF_H = 90;

/**
 * Maestri lesson: repeated "add note" clicks used to stack new notes exactly
 * on top of each other. Each successive note steps down-right in a small
 * cascade; module-level so the cascade survives remounts.
 */
const CASCADE_STEP = 32;
const CASCADE_WRAP = 8;
let cascadeCount = 0;

export function AddNoteButton() {
  const { screenToFlowPosition } = useReactFlow();
  const addNote = useNotesStore((s) => s.addNote);

  const handleClick = () => {
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
    const offset = (cascadeCount++ % CASCADE_WRAP) * CASCADE_STEP;
    addNote(center.x - NOTE_HALF_W + offset, center.y - NOTE_HALF_H + offset);
  };

  return (
    <Panel position="top-left">
      <button
        type="button"
        className="add-note-button"
        title="Nova nota adesiva"
        aria-label="Nova nota adesiva"
        onClick={handleClick}
      >
        + Nota
      </button>
    </Panel>
  );
}
