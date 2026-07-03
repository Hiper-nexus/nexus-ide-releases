import { ipcMain } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import {
  spawnRequestSchema,
  writeSchema,
  resizeSchema,
  killSchema,
} from '../../shared/ipc';
import type { SpawnResult } from '../../shared/types';
import {
  spawnSession,
  writeSession,
  resizeSession,
  killSession,
} from './pty-manager';

/**
 * Registers the PTY IPC surface. Every handler validates its payload with zod
 * before touching the PTY manager, and `spawn` never leaks a raw error string
 * beyond a short message.
 */
export function registerPtyIpc(): void {
  ipcMain.handle(PTY_CHANNELS.spawn, (event, raw): SpawnResult => {
    const parsed = spawnRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid spawn request' };
    }
    try {
      const { sessionId } = spawnSession(event.sender, parsed.data);
      return { ok: true, sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to spawn shell';
      return { ok: false, error: message };
    }
  });

  ipcMain.on(PTY_CHANNELS.write, (event, raw) => {
    const parsed = writeSchema.safeParse(raw);
    if (parsed.success) {
      writeSession(event.sender, parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.on(PTY_CHANNELS.resize, (event, raw) => {
    const parsed = resizeSchema.safeParse(raw);
    if (parsed.success) {
      resizeSession(
        event.sender,
        parsed.data.sessionId,
        parsed.data.cols,
        parsed.data.rows,
      );
    }
  });

  ipcMain.on(PTY_CHANNELS.kill, (event, raw) => {
    const parsed = killSchema.safeParse(raw);
    if (parsed.success) {
      killSession(event.sender, parsed.data.sessionId);
    }
  });
}
