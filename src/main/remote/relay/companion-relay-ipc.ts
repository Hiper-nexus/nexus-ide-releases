/**
 * IPC tipado do transporte relay do companion mobile (padrão dos canais do
 * remote atual: zod na entrada, scope vivo do renderer, respostas com shape
 * estável). Integração de UI fica de fora nesta entrega — estes canais expõem
 * start/stop + link/QR para a UI futura.
 *
 * Fail closed: tudo atrás de `feature.remote.relayTransport` (default OFF) e
 * de uma URL de relay explícita (default vazio = desligado; my.omp.sh é
 * rejeitado pelo room-link).
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import {
  COMPANION_RELAY_CHANNELS,
  type CompanionRelayTransportInfo,
} from '../../../shared/companion-relay-types';
import { FEATURE_FLAG_IDS } from '../../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../../feature-flags/feature-flag-registry';
import { requireLiveRendererWorkspaceScope } from '../../persistence/renderer-workspace-scope';
import { handleAuthedMessage } from '../remote-bridge';
import {
  getCompanionRelayTransportInfo,
  startCompanionRelayTransport,
  stopCompanionRelayTransport,
} from './companion-relay-transport';
import { initCompanionRelayPtyBridge } from './companion-relay-pty-bridge';

const startSchema = z
  .object({
    relayUrl: z.string().min(1).max(512),
  })
  .strict();

function withError(
  info: CompanionRelayTransportInfo,
  error: string,
): CompanionRelayTransportInfo {
  return { ...info, error };
}

export function registerCompanionRelayIpc(): void {
  // Encaminhamento PTY → relay: tap único, no-op enquanto não há host ativo.
  initCompanionRelayPtyBridge();

  ipcMain.handle(COMPANION_RELAY_CHANNELS.status, (event) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    return getCompanionRelayTransportInfo(scope);
  });

  ipcMain.handle(COMPANION_RELAY_CHANNELS.start, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    if (
      !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.remoteRelayTransport)
    ) {
      return withError(
        getCompanionRelayTransportInfo(scope),
        'relay transport disabled by feature flag',
      );
    }
    const parsed = startSchema.safeParse(raw);
    if (!parsed.success) {
      return withError(
        getCompanionRelayTransportInfo(scope),
        'invalid relay start request',
      );
    }
    try {
      return await startCompanionRelayTransport({
        relayUrl: parsed.data.relayUrl,
        scope,
        dispatch: handleAuthedMessage,
      });
    } catch (err) {
      return withError(
        getCompanionRelayTransportInfo(scope),
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  ipcMain.handle(COMPANION_RELAY_CHANNELS.stop, (event) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    try {
      return stopCompanionRelayTransport(scope);
    } catch (err) {
      return withError(
        getCompanionRelayTransportInfo(scope),
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}
