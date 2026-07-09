/**
 * C3 defesa em profundidade (follow-ups 2 e 4b): decide o destino de um
 * send_to_pane SEM efeitos. Um paneId explícito (resposta roteada de pergunta
 * pendente) só vale se o pane ainda existir E for pane de agente/orquestrador —
 * jamais escrita direta em shell/browser. E paneId presente NUNCA cai no gate
 * de delegação: pane sumido vira aviso + re-pergunta, não "Confirmo?" da
 * resposta como se fosse missão nova.
 */

export interface SendToPanePaneLike {
  id: string;
  title: string;
  kind: string;
  orchRequestId?: string;
}

const ORCH_TITLE_RE = /(^|[ ·])orq\b/i;

export function isOrchestratorPane(pane: SendToPanePaneLike): boolean {
  return Boolean(pane.orchRequestId?.startsWith('squad-')) || ORCH_TITLE_RE.test(pane.title);
}

/** Pane que pode receber texto autorado por LLM/roteado: agente CLI ou orquestrador. */
export function isAgentTargetPane(pane: SendToPanePaneLike): boolean {
  return pane.kind === 'cli-agent' || isOrchestratorPane(pane);
}

export type SendToPaneTarget =
  | { kind: 'asking-pane'; paneId: string }
  | { kind: 'asking-pane-gone' }
  | { kind: 'asking-pane-not-agent'; title: string }
  | { kind: 'delegation'; orchestratorPaneId: string }
  | { kind: 'no-agent-pane' };

export function resolveSendToPaneTarget(
  requestedPaneId: string | undefined,
  panes: SendToPanePaneLike[],
): SendToPaneTarget {
  if (requestedPaneId) {
    const pane = panes.find((p) => p.id === requestedPaneId);
    if (!pane) return { kind: 'asking-pane-gone' };
    if (!isAgentTargetPane(pane)) return { kind: 'asking-pane-not-agent', title: pane.title };
    return { kind: 'asking-pane', paneId: pane.id };
  }
  const orchestrator = panes.find(isOrchestratorPane);
  if (!orchestrator) return { kind: 'no-agent-pane' };
  return { kind: 'delegation', orchestratorPaneId: orchestrator.id };
}
