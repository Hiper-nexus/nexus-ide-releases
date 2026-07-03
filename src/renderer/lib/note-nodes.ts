import type { Node } from '@xyflow/react';
import type { Note } from '../../shared/note-types';
import { useNotesStore } from '../state/notes-store';
import type { StickyNoteNodeData } from '../components/StickyNoteNode';

/**
 * Pure mapping between Note models and xyflow nodes. Note node ids are
 * namespaced (`note:<id>`) so they can share the nodes array with pane nodes
 * (whose ids are raw pane ids) without collisions — CanvasView concatenates
 * `buildNoteNodes(notes)` onto its pane nodes and routes drag-stop by
 * `isNoteNodeId`.
 */

export const NOTE_NODE_TYPE = 'stickyNote' as const;

const NOTE_NODE_PREFIX = 'note:';

/** Above unfocused panes (layout z is small), below the focused pane (1000). */
const NOTE_Z_INDEX = 500;

export function isNoteNodeId(nodeId: string): boolean {
  return nodeId.startsWith(NOTE_NODE_PREFIX);
}

/** `note:<id>` → `<id>`, or null when the node is not a note node. */
export function noteFromNodeId(nodeId: string): string | null {
  return isNoteNodeId(nodeId) ? nodeId.slice(NOTE_NODE_PREFIX.length) : null;
}

export type StickyNoteNode = Node<StickyNoteNodeData, typeof NOTE_NODE_TYPE>;

export function buildNoteNodes(notes: Note[]): StickyNoteNode[] {
  return notes.map((note) => ({
    id: `${NOTE_NODE_PREFIX}${note.id}`,
    type: NOTE_NODE_TYPE,
    position: { x: note.x, y: note.y },
    width: note.w,
    height: note.h,
    zIndex: NOTE_Z_INDEX,
    dragHandle: '.note-drag-handle',
    data: { note },
    // Prevent xyflow from auto-measuring (same discipline as pane nodes).
    measured: { width: note.w, height: note.h },
    style: { width: note.w, height: note.h },
  }));
}

/**
 * Persist a note position after an xyflow drag. Safe to call with any node id
 * — non-note nodes are ignored, so CanvasView's onNodeDragStop can forward
 * unconditionally. Non-finite coordinates (the Maestri corrupted-drag class)
 * are dropped before they can poison the store.
 */
export function onNoteDragStop(nodeId: string, x: number, y: number): void {
  const noteId = noteFromNodeId(nodeId);
  if (!noteId) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  useNotesStore.getState().updateNote(noteId, { x, y });
}
