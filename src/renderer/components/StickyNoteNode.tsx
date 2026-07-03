import { memo, useCallback } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { Note } from '../../shared/note-types';
import { useNotesStore } from '../state/notes-store';
import { StickyNote } from './StickyNote';

/**
 * xyflow wrapper around <StickyNote>. Dragging is owned by xyflow via the
 * node's `dragHandle: '.note-drag-handle'` (set in lib/note-nodes.ts), so
 * `onMove` is intentionally omitted — see the interaction contract in
 * StickyNote.tsx. No <Handle> yet; connectable edges land with the edge combo.
 */

export type StickyNoteNodeData = { note: Note };

export type StickyNoteNodeType = Node<StickyNoteNodeData, 'stickyNote'>;

export const StickyNoteNode = memo(function StickyNoteNode({
  data,
}: NodeProps<StickyNoteNodeType>) {
  const { note } = data;
  const updateNote = useNotesStore((s) => s.updateNote);
  const removeNote = useNotesStore((s) => s.removeNote);

  const handleChange = useCallback(
    (patch: Partial<Omit<Note, 'id'>>) => updateNote(note.id, patch),
    [note.id, updateNote],
  );
  const handleRemove = useCallback(
    () => removeNote(note.id),
    [note.id, removeNote],
  );

  return (
    <StickyNote note={note} onChange={handleChange} onRemove={handleRemove} />
  );
});
