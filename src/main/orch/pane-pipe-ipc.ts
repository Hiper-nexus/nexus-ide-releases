import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  PIPE_CHANNELS,
  addPipeSchema,
  pipeIdSchema,
} from '../../shared/pipe-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  addPipe,
  clearPipePartitions,
  initPanePipes,
  listPipes,
  onPipesChange,
  removePipe,
} from './pane-pipe';
import { sameProjectScope } from './project-scoped-broadcast';

/** Renderer-facing IPC for owner/project-partitioned pane pipes. */

const listeners = new Set<WebContents>();
const destroyHandlers = new Map<WebContents, () => void>();
let unsubscribeScopeChanges: (() => void) | null = null;

function broadcast(owner: WebContents, scope: ProjectExecutionScope): void {
  if (!listeners.has(owner) || owner.isDestroyed() || owner.isCrashed()) {
    return;
  }
  const currentScope = getRendererWorkspaceScope(owner);
  if (!currentScope || !sameProjectScope(currentScope, scope)) return;
  owner.send(PIPE_CHANNELS.changed, listPipes(owner, scope));
}

function ensureScopeChangeListener(): void {
  if (unsubscribeScopeChanges) return;
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange(
    (changedOwner, previous) => {
      if (!previous) return;
      for (const owner of listeners) {
        if (owner.id === changedOwner.id) {
          clearPipePartitions(owner, previous);
        }
      }
    },
  );
}

export function registerPipeListener(wc: WebContents): void {
  listeners.add(wc);
  ensureScopeChangeListener();
  if (destroyHandlers.has(wc)) return;
  const onDestroyed = () => unregisterPipeListener(wc);
  destroyHandlers.set(wc, onDestroyed);
  wc.once('destroyed', onDestroyed);
}

export function unregisterPipeListener(wc: WebContents): void {
  listeners.delete(wc);
  const onDestroyed = destroyHandlers.get(wc);
  if (onDestroyed) wc.removeListener('destroyed', onDestroyed);
  destroyHandlers.delete(wc);
  clearPipePartitions(wc);
  if (listeners.size === 0) {
    unsubscribeScopeChanges?.();
    unsubscribeScopeChanges = null;
  }
}

function requireRegisteredScope(wc: WebContents): ProjectExecutionScope {
  if (!listeners.has(wc)) {
    throw new Error('renderer is not registered for pane pipes');
  }
  return requireRendererWorkspaceScope(wc);
}

export function registerPipeIpc(): void {
  initPanePipes();
  onPipesChange(broadcast);

  ipcMain.handle(PIPE_CHANNELS.list, (event) => {
    const scope = requireRegisteredScope(event.sender);
    return listPipes(event.sender, scope);
  });

  ipcMain.handle(PIPE_CHANNELS.add, (event, raw) => {
    const scope = requireRegisteredScope(event.sender);
    const parsed = addPipeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid pipe' };
    const pipe = addPipe(
      event.sender,
      scope,
      parsed.data.sourcePaneId,
      parsed.data.targetPaneId,
      parsed.data.mode,
    );
    return pipe
      ? { ok: true, id: pipe.id }
      : { ok: false, error: 'pane authority mismatch' };
  });

  ipcMain.handle(PIPE_CHANNELS.remove, (event, raw) => {
    const scope = requireRegisteredScope(event.sender);
    const parsed = pipeIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    return { ok: removePipe(event.sender, scope, parsed.data.id) };
  });
}
