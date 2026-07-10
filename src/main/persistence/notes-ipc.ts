import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  NOTE_CHANNELS,
  listNotesSchema,
  removeNoteSchema,
  saveNoteSchema,
  type NotesChangedEvent,
} from '../../shared/note-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { broadcastToProject } from '../orch/project-scoped-broadcast';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedNotesStore, type ScopedNote } from './notes-store';
import { requireRendererWorkspaceScope } from './renderer-workspace-scope';

/** Registered windows are filtered by their current main-owned scope. */
const listeners = new Set<WebContents>();

function assertWorkspaceIntent(
  scope: ProjectExecutionScope,
  workspacePath: string,
): void {
  if (workspacePath !== scope.rootRealPath) {
    throw new Error('workspace request does not match renderer scope');
  }
}

function broadcast(
  scope: ProjectExecutionScope,
  notes: ScopedNote[],
): void {
  const event: NotesChangedEvent = {
    workspacePath: scope.rootRealPath,
    notes,
  };
  broadcastToProject(listeners, scope, NOTE_CHANNELS.changed, event);
}

export function registerNotesListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterNotesListener(wc: WebContents): void {
  listeners.delete(wc);
}

/**
 * Renderer paths remain in the wire format for compatibility, but they never
 * select storage. Every handler captures its sender's trusted scope first.
 */
export function registerNotesIpc(
  runtimeManager: ProjectRuntimeManager,
): void {
  ipcMain.handle(NOTE_CHANNELS.list, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = listNotesSchema.safeParse(raw);
    if (!parsed.success) return [];
    assertWorkspaceIntent(scope, parsed.data.workspacePath);
    return createScopedNotesStore(runtimeManager, scope).list();
  });

  ipcMain.handle(NOTE_CHANNELS.save, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = saveNoteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid note' };
    assertWorkspaceIntent(scope, parsed.data.workspacePath);
    const store = createScopedNotesStore(runtimeManager, scope);
    store.save(parsed.data.note);
    broadcast(scope, store.list());
    return { ok: true };
  });

  ipcMain.handle(NOTE_CHANNELS.remove, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = removeNoteSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const store = createScopedNotesStore(runtimeManager, scope);
    const removed = store.remove(parsed.data.id);
    if (removed) broadcast(scope, store.list());
    return { ok: removed };
  });
}
