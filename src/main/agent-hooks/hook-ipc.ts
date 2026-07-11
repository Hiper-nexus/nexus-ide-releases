/**
 * IPC entry for production agent-hook status ingest.
 * Renderer/main callers may report explicit provider status; evidence never
 * authorized here (§12.4).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AGENT_HOOK_CHANNELS } from '../../shared/channels';
import { ingestAgentHookStatus } from './hook-ingest';

export function registerAgentHookIpc(): void {
  ipcMain.handle(
    AGENT_HOOK_CHANNELS.ingestStatus,
    (
      _event: IpcMainInvokeEvent,
      raw: { sessionId?: unknown; payload?: unknown; pathname?: unknown },
    ) => {
      const sessionId =
        typeof raw?.sessionId === 'string' ? raw.sessionId : '';
      const pathname =
        typeof raw?.pathname === 'string' ? raw.pathname : undefined;
      return ingestAgentHookStatus(sessionId, raw?.payload, { pathname });
    },
  );
}
