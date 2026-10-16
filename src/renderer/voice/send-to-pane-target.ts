/**
 * C3 defesa em profundidade (follow-ups 2 e 4b): decide o destino de um
 * send_to_pane SEM efeitos. Um paneId explícito (resposta roteada de pergunta
 * pendente) só vale se o pane ainda existir E for pane de agente/orquestrador —
 * jamais escrita direta em shell/browser. E paneId presente NUNCA cai no gate
 * de delegação: pane sumido vira aviso + re-pergunta, não "Confirmo?" da
 * resposta como se fosse missão nova.
 *
 * Também resolve o NÚMERO do pane ("pane 7", "pane sete"), que é o endereço
 * que o operador consegue ditar. O número é testado antes do título e não cai
 * para o título quando falha — ver o comentário no corpo.
 */

import { parsePaneNumberRef } from '../../shared/pane-number';

export interface SendToPanePaneLike {
  id: string;
  title: string;
  kind: string;
  orchRequestId?: string;
  /** Número curto que o operador lê no header e dita ("manda no pane 7"). */
  paneNumber?: number;
}

const ORCH_TITLE_RE = /(^|[ ·])orq\b/i;

export function isOrchestratorPane(pane: SendToPanePaneLike): boolean {
  return Boolean(pane.orchRequestId?.startsWith('squad-')) || ORCH_TITLE_RE.test(pane.title);
}

/** Pane que pode receber texto autorado por LLM/roteado: agente CLI ou orquestrador. */
export function isAgentTargetPane(pane: SendToPanePaneLike): boolean {
  return pane.kind === 'cli-agent' || isOrchestratorPane(pane);
}

/** Terminal comum (shell), fora o do orquestrador: o texto entregue ali é comando. */
export function isTerminalTargetPane(pane: SendToPanePaneLike): boolean {
  return pane.kind === 'shell' && !isOrchestratorPane(pane);
}

export interface ResolveSendToPaneOptions {
  /**
   * Um alvo EXPLÍCITO (id, número ou título pedido pelo operador) pode ser um
   * terminal. O resultado vem marcado `terminal: true` e o chamador trata o
   * texto como comando (uma linha, confirmação de destrutivo/deploy). Só o
   * send_to_pane liga isso; ask_pane e sync_repo_via_pane seguem só com agentes.
   */
  allowTerminal?: boolean;
}

export type SendToPaneTarget =
  | {
      kind: 'asking-pane';
      paneId: string;
      /** Alvo é um terminal (shell): o texto é COMANDO, não prompt de agente. */
      terminal?: true;
    }
  | {
      kind: 'asking-pane-gone';
      /**
       * Preenchidos só quando o operador citou um NÚMERO que não resolve. São
       * opcionais de propósito: `{ kind: 'asking-pane-gone' }` continua sendo
       * um valor válido, então nenhum consumidor existente muda de
       * comportamento — quem sabe ler os campos dá uma recusa melhor.
       */
      requestedNumber?: number;
      validNumbers?: readonly number[];
    }
  | { kind: 'asking-pane-not-agent'; title: string }
  | { kind: 'asking-pane-ambiguous'; titles: string[] }
  | { kind: 'delegation'; orchestratorPaneId: string }
  | { kind: 'no-agent-pane' };

export function resolveSendToPaneTarget(
  requestedPaneId: string | undefined,
  panes: SendToPanePaneLike[],
  focusedPaneId?: string | null,
  options: ResolveSendToPaneOptions = {},
): SendToPaneTarget {
  const classify = (pane: SendToPanePaneLike): SendToPaneTarget => {
    if (isAgentTargetPane(pane)) return { kind: 'asking-pane', paneId: pane.id };
    if (options.allowTerminal && isTerminalTargetPane(pane)) {
      return { kind: 'asking-pane', paneId: pane.id, terminal: true };
    }
    return { kind: 'asking-pane-not-agent', title: pane.title };
  };
  if (requestedPaneId) {
    const exact = panes.find((p) => p.id === requestedPaneId);
    // NÚMERO ANTES DO TÍTULO, e sem cair no título depois.
    //
    // "pane 7" normaliza para "7", e a busca por título faz substring: um pane
    // chamado "claude-7" casaria e receberia o trabalho destinado ao pane 7.
    // Silenciosamente mandar para o terminal errado é pior que recusar, então
    // um número que não resolve para EXATAMENTE um pane vira recusa nomeando os
    // números válidos — nunca um chute, nunca o pane focado.
    if (!exact) {
      const wantedNumber = parsePaneNumberRef(requestedPaneId);
      if (wantedNumber !== null) {
        const numbered = panes.filter((p) => p.paneNumber === wantedNumber);
        if (numbered.length > 1) {
          return {
            kind: 'asking-pane-ambiguous',
            titles: numbered.map((p) => p.title),
          };
        }
        const pane = numbered[0];
        if (!pane) {
          return {
            kind: 'asking-pane-gone',
            requestedNumber: wantedNumber,
            validNumbers: livePaneNumbersOf(panes),
          };
        }
        return classify(pane);
      }
    }
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
    return classify(pane);
  }
  const orchestrator = panes.find(isOrchestratorPane);
  if (orchestrator) return { kind: 'delegation', orchestratorPaneId: orchestrator.id };
  const focused = panes.find((pane) => pane.id === focusedPaneId && isAgentTargetPane(pane));
  if (focused) return { kind: 'delegation', orchestratorPaneId: focused.id };
  return { kind: 'no-agent-pane' };
}

/**
 * Everyday repo sync prefers a real AI CLI pane over the orchestrator so the
 * product prompt runs where users already do git (Claude/Codex/…), not as a
 * squad mission rewrite.
 */
export function resolveSyncRepoViaPaneTarget(
  requestedPaneId: string | undefined,
  panes: SendToPanePaneLike[],
  focusedPaneId?: string | null,
): SendToPaneTarget {
  if (requestedPaneId) {
    return resolveSendToPaneTarget(requestedPaneId, panes, focusedPaneId);
  }
  // Prefer the focused CLI only — never silently pick an arbitrary first pane.
  const focusedCli = panes.find(
    (pane) => pane.id === focusedPaneId && pane.kind === 'cli-agent',
  );
  if (focusedCli) return { kind: 'asking-pane', paneId: focusedCli.id };
  const cliPanes = panes.filter((pane) => pane.kind === 'cli-agent');
  if (cliPanes.length === 1) {
    return { kind: 'asking-pane', paneId: cliPanes[0].id };
  }
  if (cliPanes.length > 1) {
    return {
      kind: 'asking-pane-ambiguous',
      titles: cliPanes.map((pane) => pane.title),
    };
  }
  return resolveSendToPaneTarget(undefined, panes, focusedPaneId);
}

/** Números vivos, ordenados — o que a recusa precisa nomear. */
export function livePaneNumbersOf(
  panes: readonly SendToPanePaneLike[],
): readonly number[] {
  return [
    ...new Set(
      panes
        .map((pane) => pane.paneNumber)
        .filter((value): value is number => typeof value === 'number'),
    ),
  ].sort((a, b) => a - b);
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
