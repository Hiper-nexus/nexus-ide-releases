/**
 * Liga a saída dos panes PTY ao transporte relay do companion mobile.
 *
 * Não-invasivo e fail-safe: instala UM tap de sessão (`tapSessionData`) que,
 * quando existe um host de relay ativo, encaminha cada chunk de output para os
 * guests via `pushPaneOutput`. Sem host ativo (o caso comum, flag OFF) o tap
 * retorna de imediato — custo desprezível e zero efeito sobre o terminal local.
 *
 * O que o mobile vê é decidido pela MESMA autoridade de pane do remote-bridge:
 * só encaminhamos panes que o caller do relay (role 'user', escopo do host)
 * pode LER (`authorizePaneAccess(..., 'read')`). Panes de outro project/checkout
 * são silenciosamente descartados — o relay é amarrado a um único escopo.
 *
 * NUNCA logar sessionId/paneId/payload aqui: o encaminhamento é mudo e qualquer
 * falha é engolida para nunca quebrar o caminho de output do PTY.
 */
import { tapSessionData } from '../../pty/pty-manager';
import { getPaneAuthzInfo } from '../../orch/pane-registry';
import { authorizePaneAccess } from '../../orch/pane-authz';
import { getActiveCompanionRelayHost } from './companion-relay-transport';

let untap: (() => void) | null = null;

/**
 * Instala o encaminhamento PTY → relay uma única vez. Idempotente: chamadas
 * repetidas devolvem o mesmo disposer sem registrar taps duplicados.
 */
export function initCompanionRelayPtyBridge(): () => void {
  if (untap) return untap;
  untap = tapSessionData((sessionId, data) => {
    if (data.length === 0) return;
    // Sem host ativo não há nada a encaminhar (flag OFF / relay parado).
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
      host.pushPaneOutput(pane.paneId, sessionId, data);
    } catch {
      // Fail-safe: o relay jamais pode quebrar o output local do PTY.
    }
  });
  return untap;
}

/** Remove o tap (testes / shutdown). No-op quando não instalado. */
export function disposeCompanionRelayPtyBridge(): void {
  if (untap) {
    untap();
    untap = null;
  }
}
