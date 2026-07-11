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
  | { kind: 'asking-pane-ambiguous'; titles: string[] }
  | { kind: 'delegation'; orchestratorPaneId: string }
  | { kind: 'no-agent-pane' };

export function resolveSendToPaneTarget(
  requestedPaneId: string | undefined,
  panes: SendToPanePaneLike[],
  focusedPaneId?: string | null,
): SendToPaneTarget {
  if (requestedPaneId) {
    const exact = panes.find((p) => p.id === requestedPaneId);
    const wanted = normalizePaneName(requestedPaneId);
    const named = exact
      ? []
      : panes.filter((p) => normalizePaneName(p.title) === wanted);
    const partial = exact || named.length
      ? []
      : panes.filter((p) => {
          const title = normalizePaneName(p.title);
          return title.includes(wanted) || wanted.includes(title);
        });
    const candidates = exact ? [exact] : (named.length ? named : partial);
    if (candidates.length > 1) {
      return { kind: 'asking-pane-ambiguous', titles: candidates.map((p) => p.title) };
    }
    const pane = candidates[0];
    if (!pane) return { kind: 'asking-pane-gone' };
    if (!isAgentTargetPane(pane)) return { kind: 'asking-pane-not-agent', title: pane.title };
    return { kind: 'asking-pane', paneId: pane.id };
  }
  const orchestrator = panes.find(isOrchestratorPane);
  if (orchestrator) return { kind: 'delegation', orchestratorPaneId: orchestrator.id };
  const focused = panes.find((pane) => pane.id === focusedPaneId && isAgentTargetPane(pane));
  if (focused) return { kind: 'delegation', orchestratorPaneId: focused.id };
  return { kind: 'no-agent-pane' };
}

function normalizePaneName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(pane|painel|terminal|agente)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
