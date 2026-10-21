import { JEV_CHANNELS } from '../../shared/jev-channels';
import {
  paneRouteRequestSchema,
  type PaneRouteRequest,
  type PaneRouteResult,
} from '../../shared/pane-route';
import { handleTrusted } from '../security/trusted-ipc';
import { proposePaneRoute } from './jev-pane-route';

/**
 * IPC da proposta de esforço/skill do "+ Pane". Só o frame principal da janela
 * principal chega aqui (`handleTrusted`); o payload é `unknown` até o schema
 * estrito aceitá-lo — chave desconhecida (missionId, sessionId, conta) é
 * recusada, porque o renderer nunca envia autoridade ao Main.
 *
 * A resposta é SEMPRE um resultado tipado: erro inesperado não vira exceção
 * nem leva texto de falha ao renderer, e "sem proposta" é um resultado normal
 * — o "+ Pane" segue abrindo o pane exatamente como sempre fez.
 */
export function registerPaneRouteIpc(
  propose: (request: PaneRouteRequest) => Promise<PaneRouteResult> = proposePaneRoute,
): void {
  handleTrusted(
    JEV_CHANNELS.paneRoute,
    async (_event, raw): Promise<PaneRouteResult> => {
      const parsed = paneRouteRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: 'empty' };
      try {
        return await propose(parsed.data);
      } catch {
        return { ok: false, reason: 'error' };
      }
    },
  );
}
