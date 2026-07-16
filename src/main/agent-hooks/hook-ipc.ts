/**
 * IPC entry for production agent-hook status ingest.
 * Renderer/main callers may report explicit provider status; evidence never
 * authorized here (§12.4).
 *
 * Authorization (M5): unlike the token-authenticated HTTP twin, this IPC channel
 * previously trusted any renderer to publish state (and poison the persisted
 * provider-session/resume id) for an *arbitrary*, enumerable PTY session id. We
 * now require the calling renderer to actually OWN the session — the same
 * sender→session binding the PTY layer already enforces — so a compromised
 * renderer can no longer spoof another pane's orchestration state or resume id.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AGENT_HOOK_CHANNELS } from '../../shared/channels';
import { ingestAgentHookStatus } from './hook-ingest';
import { getOwnedAgentSessionInfo } from '../pty/pty-manager';

export function registerAgentHookIpc(): void {
  ipcMain.handle(
    AGENT_HOOK_CHANNELS.ingestStatus,
    (
      event: IpcMainInvokeEvent,
      raw: { sessionId?: unknown; payload?: unknown; pathname?: unknown },
    ) => {
      const sessionId =
        typeof raw?.sessionId === 'string' ? raw.sessionId : '';
      const pathname =
        typeof raw?.pathname === 'string' ? raw.pathname : undefined;
      // Fail closed: only the renderer that owns this PTY session may report
      // status for it. This blocks cross-session state spoofing and provider
      // resume-id poisoning from a compromised/hostile renderer.
      if (!sessionId || !getOwnedAgentSessionInfo(event.sender, sessionId)) {
        return { ok: false, error: 'not authorized for session' };
      }
      return ingestAgentHookStatus(sessionId, raw?.payload, { pathname });
    },
  );
}
