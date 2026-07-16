/**
 * IPC read-only da descoberta universal de configs (entrega B4).
 *
 * Um único canal invoke (`discovery:workspace-configs`) que devolve o
 * inventário do workspace do sender — sem UI (o painel vem depois).
 * Sem flag de feature, pelo mesmo racional do product:mcpHub.observe:
 * inventário read-only de configs no disco deve funcionar mesmo com o hub
 * desligado. Nada é escrito; segredos saem mascarados para o renderer.
 */
import { ipcMain } from 'electron';
import { DISCOVERY_CHANNELS } from '../../shared/channels';
import { requireScopedRoot } from '../security/scoped-workspace-fs';
import {
  discoverWorkspaceConfigs,
  maskWorkspaceDiscoveryForUi,
} from './workspace-discovery-service';

export function registerDiscoveryIpc(): void {
  ipcMain.handle(DISCOVERY_CHANNELS.workspaceConfigs, (event) => {
    // Workspace sempre derivado do sender (fail-closed) — o renderer não
    // escolhe raiz arbitrária.
    const { root } = requireScopedRoot(event.sender);
    return maskWorkspaceDiscoveryForUi(discoverWorkspaceConfigs(root));
  });
}
