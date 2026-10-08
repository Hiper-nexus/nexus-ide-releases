/**
 * Liga a saída dos panes PTY ao transporte relay do companion mobile.
 *
 * Não-invasivo e fail-safe: consome o `remote-output-bus` (tap único de PTY,
 * UM encode por chunk compartilhado com a bridge WS — sem host ativo o bus
 * nem encoda). Uma seq por sessão entre os dois transportes: bridge e relay
 * simultâneos não criam mais gaps falsos de seq um para o outro.
 *
 * O que o mobile vê é decidido pela MESMA autoridade de pane do remote-bridge:
 * só encaminhamos panes que o caller do relay (role 'user', escopo do host)
 * pode LER (`authorizePaneAccess(..., 'read')`). Panes de outro project/checkout
 * são silenciosamente descartados — o relay é amarrado a um único escopo.
 *
 * NUNCA logar sessionId/paneId/payload aqui: o encaminhamento é mudo e qualquer
 * falha é engolida para nunca quebrar o caminho de output do PTY.
 */
import { getPaneAuthzInfo } from '../../orch/pane-registry';
import { authorizePaneAccess } from '../../orch/pane-authz';
import { subscribeEncodedSessionOutput } from '../remote-output-bus';
import { registerRemoteApprovalResponder } from '../../agent-hooks/approval-broker';
import { getActiveCompanionRelayHost } from './companion-relay-transport';

let untap: (() => void) | null = null;

/**
 * PRV-02: um guest do relay com link de escrita e autoridade de escrita no
 * pane do pedido conta como respondente — o hook PermissionRequest espera por
 * ele. Mesma autoridade de pane do encaminhamento de saída, agora 'write'.
 */
function relayCanRespond(sessionId: string): boolean {
  const host = getActiveCompanionRelayHost();
  if (!host?.hasWritablePeer()) return false;
  const pane = getPaneAuthzInfo(sessionId);
  return pane !== null && authorizePaneAccess({ role: 'user', scope: host.scope }, pane, 'write').allow;
}

/**
 * Instala o encaminhamento PTY → relay uma única vez. Idempotente: chamadas
 * repetidas devolvem o mesmo disposer sem registrar taps duplicados.
 */
export function initCompanionRelayPtyBridge(): () => void {
  if (untap) return untap;
  const unregisterResponder = registerRemoteApprovalResponder(relayCanRespond);
  const unsubscribe = subscribeEncodedSessionOutput({
    // Sem host ativo não há nada a encaminhar (flag OFF / relay parado) — e o
    // bus nem encoda o chunk quando nenhum consumidor o quer.
    wants: () => getActiveCompanionRelayHost() !== null,
    deliver: (sessionId, encoded) => {
      const host = getActiveCompanionRelayHost();
      if (!host) return;
      try {
        const pane = getPaneAuthzInfo(sessionId);
        if (!pane) return;
        // Autoridade de pane idêntica à do bridge (pane.stream.open): só panes
        // legíveis pelo escopo do host chegam ao mobile. Fora de escopo → drop.
        const decision = authorizePaneAccess(
          { role: 'user', scope: host.scope },
          pane,
          'read',
        );
        if (!decision.allow) return;
        host.pushEncodedPaneOutput(pane.paneId, encoded);
      } catch {
        // Fail-safe: o relay jamais pode quebrar o output local do PTY.
      }
    },
  });
  untap = () => {
    unsubscribe();
    unregisterResponder();
  };
  return untap;
}

/** Remove o tap (testes / shutdown). No-op quando não instalado. */
export function disposeCompanionRelayPtyBridge(): void {
  if (untap) {
    untap();
    untap = null;
  }
}
