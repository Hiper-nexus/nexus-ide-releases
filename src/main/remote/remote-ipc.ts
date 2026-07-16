import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { z } from 'zod';
import { REMOTE_CHANNELS } from '../../shared/remote-channels';
import type { ProjectExecutionScope } from '../../shared/types';
import type { RemoteSpawnRequest } from '../../shared/remote-types';
import {
  requireLiveRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  confirmationReason,
  requiresConfirmation,
} from '../jarvis/guardrails';
import {
  getRemoteBridgeInfo,
  revokeRemoteTokens,
  rotateRemotePairing,
  startRemoteBridge,
  stopRemoteBridge,
} from './remote-bridge';
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
} from './remote-spawn';
import { registerCompanionRelayIpc } from './relay/companion-relay-ipc';

const startSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.enum(['0.0.0.0', '127.0.0.1', '::1', '::']).optional(),
});
const targetSchema = z.object({
  target: z.string().min(3).max(256),
});
const spawnSchema = z.object({
  target: z.string().min(3).max(256),
  cwd: z.string().min(1).max(4096).optional(),
  cli: z.enum(['claude', 'codex', 'agy', 'kimi']),
  sessionName: z.string().min(1).max(80).optional(),
  prompt: z.string().max(8192).optional(),
});

const REMOTE_SPAWN_TOOL = 'nexus_remote_spawn';

function safeDialogLabel(value: string, maxChars = 256): string {
  return value
    .replace(/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

async function confirmRemoteSpawn(
  owner: WebContents,
  scope: ProjectExecutionScope,
  request: RemoteSpawnRequest,
): Promise<boolean> {
  const args: Record<string, unknown> = { ...request };
  if (!requiresConfirmation(REMOTE_SPAWN_TOOL, args)) {
    throw new Error('remote spawn confirmation policy is unavailable');
  }
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('renderer window is unavailable');
  }
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Nexus IDE — autorização remota',
    buttons: ['Negar', 'Permitir'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Criar sessão remota via SSH?',
    detail:
      `Workspace: ${safeDialogLabel(scope.rootRealPath, 512)}\n` +
      `Destino: ${safeDialogLabel(request.target)}\n` +
      `CLI: ${request.cli}\n` +
      `Sessão: ${safeDialogLabel(request.sessionName ?? 'gerada pelo Nexus', 80)}\n` +
      `Motivo: ${confirmationReason(REMOTE_SPAWN_TOOL, args)}\n\n` +
      'O prompt não é exibido neste diálogo e será enviado somente após sua autorização.',
  });
  return result.response === 1;
}

export function registerRemoteIpc(): void {
  // Transporte E2E do companion via relay cego (feature.remote.relayTransport,
  // default OFF) — canais tipados em shared/companion-relay-types.
  registerCompanionRelayIpc();
  ipcMain.handle(REMOTE_CHANNELS.bridgeStatus, (event) =>
    getRemoteBridgeInfo(requireLiveRendererWorkspaceScope(event.sender)),
  );
  ipcMain.handle(REMOTE_CHANNELS.bridgeStart, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = startSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ...getRemoteBridgeInfo(scope), error: 'invalid start request' };
    }
    return startRemoteBridge(parsed.data, scope);
  });
  ipcMain.handle(REMOTE_CHANNELS.bridgeStop, (event) =>
    stopRemoteBridge(requireLiveRendererWorkspaceScope(event.sender)),
  );
  ipcMain.handle(REMOTE_CHANNELS.bridgeRotatePairing, (event) =>
    rotateRemotePairing(requireLiveRendererWorkspaceScope(event.sender)),
  );
  ipcMain.handle(REMOTE_CHANNELS.bridgeRevokeTokens, (event) =>
    revokeRemoteTokens(requireLiveRendererWorkspaceScope(event.sender)),
  );

  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnDetect, async (event, raw) => {
    requireLiveRendererWorkspaceScope(event.sender);
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { target: '', found: [], error: 'invalid target' };
    return detectRemoteClis(parsed.data.target);
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnList, async (event, raw) => {
    requireLiveRendererWorkspaceScope(event.sender);
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid target' };
    return listRemoteTmuxSessions(parsed.data.target);
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnCreate, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = spawnSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid remote spawn request' };
    const request = parsed.data as RemoteSpawnRequest;
    const approved = await confirmRemoteSpawn(event.sender, scope, request);
    if (!approved) {
      return { ok: false, target: request.target, error: 'user_denied' };
    }
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return createRemoteTmuxSession(request);
  });
}
