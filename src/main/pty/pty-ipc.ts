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
  spawnAgentSession,
  writeSession,
  resizeSession,
  killSession,
} from './pty-manager';
import { getAdapter, isAdapterInstalled } from '../adapters/adapter-registry';

/**
 * Registers the PTY IPC surface. Every handler validates its payload with zod
 * before touching the PTY manager. The `spawn` handler dispatches to either the
 * shell or agent path based on the request kind.
 */
export function registerPtyIpc(): void {
  ipcMain.handle(PTY_CHANNELS.spawn, (event, raw): SpawnResult => {
    const parsed = spawnRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid spawn request' };
    }
    const req = parsed.data;

    if (req.kind === 'cli-agent') {
      if (!req.adapterId) {
        return { ok: false, error: 'cli-agent spawn requires adapterId' };
      }
      const adapter = getAdapter(req.adapterId);
      if (!adapter) {
        return { ok: false, error: `unknown adapter: ${req.adapterId}` };
      }
      if (adapter.kind !== 'cli-pty') {
        return { ok: false, error: `adapter ${req.adapterId} is not a cli-pty adapter` };
      }
      // node-pty does not throw for a missing binary on macOS: it spawns and exits
      // 1 with no output, so the pane would show a bare "process exited (code 1)".
      // Gate on install status here to surface the actionable install command.
      if (!isAdapterInstalled(adapter.id)) {
        return {
          ok: false,
          error: `${adapter.label} not found. Install: ${adapter.install.command}`,
        };
      }
      try {
        const { sessionId } = spawnAgentSession(event.sender, req, adapter);
        return { ok: true, sessionId };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'failed to spawn agent';
        return { ok: false, error: message };
      }
    }

    try {
      const { sessionId } = spawnSession(event.sender, req);
      return { ok: true, sessionId };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'failed to spawn shell';
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
