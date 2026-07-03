import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  PIPE_CHANNELS,
  addPipeSchema,
  pipeIdSchema,
} from '../../shared/pipe-types';
import {
  addPipe,
  initPanePipes,
  listPipes,
  onPipesChange,
  removePipe,
} from './pane-pipe';

/** Renderer-facing IPC for pane pipes (same shape as account-ipc). */

const listeners = new Set<WebContents>();

function broadcast(): void {
  const snapshot = listPipes();
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(PIPE_CHANNELS.changed, snapshot);
  }
}

export function registerPipeListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterPipeListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function registerPipeIpc(): void {
  initPanePipes();
  onPipesChange(broadcast);

  ipcMain.handle(PIPE_CHANNELS.list, () => listPipes());

  ipcMain.handle(PIPE_CHANNELS.add, (_e, raw) => {
    const parsed = addPipeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid pipe' };
    const pipe = addPipe(
      parsed.data.sourcePaneId,
      parsed.data.targetPaneId,
      parsed.data.mode,
    );
    return pipe
      ? { ok: true, id: pipe.id }
      : { ok: false, error: 'source and target must be different panes' };
  });

  ipcMain.handle(PIPE_CHANNELS.remove, (_e, raw) => {
    const parsed = pipeIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    return { ok: removePipe(parsed.data.id) };
  });
}
