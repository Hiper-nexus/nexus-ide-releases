import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { z } from 'zod';
import { REMOTE_CHANNELS } from '../../shared/remote-channels';
import type { ProjectExecutionScope } from '../../shared/types';
import type { RemoteSpawnRequest } from '../../shared/remote-types';
import {
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  confirmationReason,
  requiresConfirmation,
} from '../jarvis/guardrails';
import {
  getRemoteBridgeInfo,
  getRemoteBridgeStatus,
  revokeRemoteTokens,
  rotateRemotePairing,
  setRemoteDeviceScopes,
  startRemoteBridge,
  stopRemoteBridge,
} from './remote-bridge';
import {
  createRemoteTmuxSession,
  detectRemoteClis,
  listRemoteTmuxSessions,
  type RemoteSpawnControl,
} from './remote-spawn';
import { registerCompanionRelayIpc } from './relay/companion-relay-ipc';
import {
  connectSshServer,
  forgetSshServer,
  importSshConfigHosts,
} from './ssh/ssh-bootstrap';
import { listSshHostViews } from './ssh/ssh-host-registry';

// MOB-12: escopos por aparelho (lista fechada; vazia = só status).
const deviceScopesSchema = z
  .array(z.enum(['read', 'input', 'approve', 'close']))
  .max(4);
const startSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.enum(['0.0.0.0', '127.0.0.1', '::1', '::']).optional(),
  tailscale: z.boolean().optional(),
  scopes: deviceScopesSchema.optional(),
});
const rotateSchema = z.object({ scopes: deviceScopesSchema.optional() }).strict();
const setDeviceScopesSchema = z
  .object({ deviceId: z.string().min(1).max(64), scopes: deviceScopesSchema })
  .strict();
const targetSchema = z.object({
  target: z.string().min(1).max(63),
});
const spawnSchema = z.object({
  target: z.string().min(1).max(63),
  cwd: z.string().min(1).max(4096).optional(),
  cli: z.enum(['claude', 'codex', 'agy', 'kimi']),
  sessionName: z.string().min(1).max(80).optional(),
  prompt: z.string().max(8192).optional(),
});
const sshConnectSchema = z.object({
  alias: z.string().min(1).max(63),
  host: z.string().min(1).max(253),
  user: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
  port: z.number().int().min(1).max(65535).optional(),
});
const sshAliasSchema = z.object({
  alias: z.string().min(1).max(63),
});

const REMOTE_SPAWN_TOOL = 'nexus_remote_spawn';

interface RendererRemoteAuthority extends RemoteSpawnControl {
  assertCurrentAuthority(): void;
  dispose(): void;
}

function rendererRemoteAuthority(
  owner: WebContents,
  scope: ProjectExecutionScope,
): RendererRemoteAuthority {
  const controller = new AbortController();
  const revoke = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(
      reason instanceof Error
        ? reason
        : new Error('renderer workspace authority changed'),
    );
  };
  const assertCurrentAuthority = () => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error('renderer workspace authority changed');
    }
    try {
      requireLiveRendererWorkspaceScope(owner, scope);
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const unsubscribeScope = onRendererWorkspaceScopeChange((changedOwner) => {
    if (changedOwner.id !== owner.id) return;
    try {
      assertCurrentAuthority();
    } catch {
      // The signal transports the exact failure into SSH/process boundaries.
    }
  });
  const eventOwner = owner as WebContents & {
    on?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
  };
  const onUnavailable = () => revoke(new Error('renderer is unavailable'));
  eventOwner.on?.('destroyed', onUnavailable);
  eventOwner.on?.('render-process-gone', onUnavailable);
  return {
    signal: controller.signal,
    assertCurrentAuthority,
    dispose: () => {
      unsubscribeScope();
      eventOwner.removeListener?.('destroyed', onUnavailable);
      eventOwner.removeListener?.('render-process-gone', onUnavailable);
    },
  };
}

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
    getRemoteBridgeStatus(requireLiveRendererWorkspaceScope(event.sender)),
  );
  ipcMain.handle(REMOTE_CHANNELS.bridgeStart, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = startSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ...getRemoteBridgeInfo(scope), error: 'invalid start request' };
    }
    const authority = rendererRemoteAuthority(event.sender, scope);
    const wasRunning = getRemoteBridgeInfo(scope).running;
    try {
      authority.assertCurrentAuthority();
      const info = await startRemoteBridge(parsed.data, scope);
      authority.assertCurrentAuthority();
      return info;
    } catch (error) {
      if (!wasRunning) {
        try {
          stopRemoteBridge(scope);
        } catch {
          // Starting failed before ownership materialized, or cleanup already ran.
        }
      }
      throw error;
    } finally {
      authority.dispose();
    }
  });
  ipcMain.handle(REMOTE_CHANNELS.bridgeStop, (event) =>
    stopRemoteBridge(requireLiveRendererWorkspaceScope(event.sender)),
  );
  ipcMain.handle(REMOTE_CHANNELS.bridgeRotatePairing, (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = rotateSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ...getRemoteBridgeInfo(scope), error: 'invalid rotate request' };
    }
    return rotateRemotePairing(scope, parsed.data.scopes);
  });
  // MOB-12: editar os escopos de um aparelho pareado.
  ipcMain.handle(REMOTE_CHANNELS.bridgeSetDeviceScopes, (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = setDeviceScopesSchema.safeParse(raw);
    if (!parsed.success) {
      return { ...getRemoteBridgeInfo(scope), error: 'invalid device scopes request' };
    }
    try {
      return setRemoteDeviceScopes(scope, parsed.data.deviceId, parsed.data.scopes);
    } catch (error) {
      return {
        ...getRemoteBridgeInfo(scope),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle(REMOTE_CHANNELS.bridgeRevokeTokens, (event) =>
    revokeRemoteTokens(requireLiveRendererWorkspaceScope(event.sender)),
  );

  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnDetect, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { target: '', found: [], error: 'invalid target' };
    const authority = rendererRemoteAuthority(event.sender, scope);
    try {
      const result = await detectRemoteClis(parsed.data.target, authority);
      authority.assertCurrentAuthority();
      return result;
    } finally {
      authority.dispose();
    }
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnList, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid target' };
    const authority = rendererRemoteAuthority(event.sender, scope);
    try {
      const result = await listRemoteTmuxSessions(parsed.data.target, authority);
      authority.assertCurrentAuthority();
      return result;
    } finally {
      authority.dispose();
    }
  });
  ipcMain.handle(REMOTE_CHANNELS.remoteSpawnCreate, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = spawnSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, target: '', error: 'invalid remote spawn request' };
    const request = parsed.data as RemoteSpawnRequest;
    const authority = rendererRemoteAuthority(event.sender, scope);
    try {
      const approved = await confirmRemoteSpawn(event.sender, scope, request);
      authority.assertCurrentAuthority();
      if (!approved) {
        return { ok: false, target: request.target, error: 'user_denied' };
      }
      const result = await createRemoteTmuxSession(request, authority);
      authority.assertCurrentAuthority();
      return result;
    } finally {
      authority.dispose();
    }
  });

  ipcMain.handle(REMOTE_CHANNELS.sshList, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return listSshHostViews();
  });
  ipcMain.handle(REMOTE_CHANNELS.sshConnect, async (event, raw) => {
    requireLiveRendererWorkspaceScope(event.sender);
    const parsed = sshConnectSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'Dados de conexão inválidos.', errorKind: 'invalid' };
    }
    const request = parsed.data;
    try {
      return await connectSshServer(request);
    } finally {
      request.password = '';
    }
  });
  ipcMain.handle(REMOTE_CHANNELS.sshImportConfig, async (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return importSshConfigHosts();
  });
  ipcMain.handle(REMOTE_CHANNELS.sshRemove, async (event, raw) => {
    requireLiveRendererWorkspaceScope(event.sender);
    const parsed = sshAliasSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'apelido inválido' };
    return forgetSshServer(parsed.data.alias);
  });
}
