import type { PaneModel, PaneSessionState } from '../../shared/types';
import { listPanes } from './split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useSessionStateStore } from '../state/session-state-store';
import { getPaneSessionId } from '../terminal/terminal-host';
import { isLivePaneSessionState } from './pane-mission-promote';
import { attentionMissionIdForPane } from './mission-attention-route';

/**
 * F-572 / t3code `revealThreadTerminal`: um terminal que já mostra o trabalho
 * é REVELADO (foco, restaurar maximize/stage, scroll), nunca duplicado por
 * outro PTY. Um pane de agente custa ~0,5–1 GB (CLI + servidores MCP filhos).
 *
 * A decisão é pura (`planPaneReveal`); o efeito (`revealPaneTerminal`) só
 * aplica o plano e explica em pt-BR.
 */

export type RevealPaneTarget =
  | { readonly kind: 'pane'; readonly paneId: string }
  | { readonly kind: 'agentSession'; readonly agentSessionId: string };

/** O mínimo de um pane para decidir revelar — sem amarrar ao PaneModel inteiro. */
export interface PaneRevealSubject {
  readonly id: string;
  readonly kind: PaneModel['kind'];
  readonly role?: 'orchestrator' | 'worker';
  readonly title?: string;
  readonly adapterId?: string;
  readonly accountId?: string;
}

export type PaneRevealPlan =
  /** Foco + restaurar maximize/stage + scroll no pane que já tem a sessão. */
  | { readonly action: 'reveal'; readonly paneId: string }
  /**
   * O pane dono da sessão existe, mas o foco está num orquestrador vivo
   * (mão do operador). Só destaca/scrolla — nunca rouba o foco.
   */
  | {
      readonly action: 'highlight';
      readonly paneId: string;
      readonly keptFocusPaneId: string;
    }
  | { readonly action: 'missing' };

export interface PlanPaneRevealInput {
  readonly panes: readonly PaneRevealSubject[];
  readonly target: RevealPaneTarget;
  readonly sessionIdOf: (paneId: string) => string | null;
  readonly focusedPaneId: string | null;
  /** Sessão física viva (spawning/busy/idle) — ausente/nula não é dono. */
  readonly isPaneSessionLive: (paneId: string) => boolean;
}

/**
 * O pane que já possui a sessão do agente. Preferir o dono da sessão a
 * qualquer outro — é ele que "já mostra o trabalho" (F-572).
 */
export function findPaneOwningAgentSession(
  panes: readonly PaneRevealSubject[],
  sessionIdOf: (paneId: string) => string | null,
  agentSessionId: string,
  isPaneSessionLive: (paneId: string) => boolean = () => true,
): PaneRevealSubject | null {
  if (!agentSessionId) return null;
  const matches = panes.filter(
    (pane) =>
      sessionIdOf(pane.id) === agentSessionId && isPaneSessionLive(pane.id),
  );
  // Duas panes com a MESMA sessão é ambiguidade de attach — fail-closed,
  // ninguém é revelado (mesma régua de `confirmedLeaderPaneId`).
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Reuso para "abrir o agente" quando um pane vivo da mesma CLI+conta já tem
 * sessão: revela em vez de nascer outro PTY. Conta distinta não casa
 * (multi-conta é trabalho diferente). Preferir ocioso a ocupado.
 */
export function findReusableAgentPane(
  panes: readonly PaneRevealSubject[],
  sessionIdOf: (paneId: string) => string | null,
  isPaneSessionLive: (paneId: string) => boolean,
  match: {
    readonly adapterId: string;
    readonly accountId?: string | undefined;
    readonly paneStates: ReadonlyMap<string, PaneSessionState>;
  },
): PaneRevealSubject | null {
  const candidates = panes.filter((pane) => {
    if (pane.kind !== 'cli-agent' || pane.adapterId !== match.adapterId) {
      return false;
    }
    // Conta fixada só casa com a mesma; sem conta no modelo casa com "de
    // padrão" (accountId ausente nos dois lados).
    if (pane.accountId !== match.accountId) return false;
    return Boolean(sessionIdOf(pane.id)) && isPaneSessionLive(pane.id);
  });
  if (candidates.length === 0) return null;
  const idle = candidates.find(
    (pane) => (match.paneStates.get(pane.id) ?? '') === 'idle',
  );
  return idle ?? candidates[0]!;
}

/** Decide revelar vs destaque vs ausente. Pura; o efeito vem depois. */
export function planPaneReveal(input: PlanPaneRevealInput): PaneRevealPlan {
  const target = input.target;
  const targetPane =
    target.kind === 'pane'
      ? (input.panes.find((pane) => pane.id === target.paneId) ?? null)
      : findPaneOwningAgentSession(
          input.panes,
          input.sessionIdOf,
          target.agentSessionId,
          input.isPaneSessionLive,
        );
  if (!targetPane) return { action: 'missing' };

  const focusedId = input.focusedPaneId;
  const focused =
    focusedId === null
      ? null
      : (input.panes.find((pane) => pane.id === focusedId) ?? null);
  // Nunca roubar o foco de um orquestrador VIVO (mão do operador): o alvo é
  // revelado em destaque, e o operador continua no Maestro. O dono da sessão
  // continua sendo preferido — se ele É o orquestrador focado, o reveal
  // apenas confirma (sem highlight).
  const stealsFromLiveOrchestrator =
    focused !== null &&
    focused.role === 'orchestrator' &&
    focused.id !== targetPane.id &&
    input.isPaneSessionLive(focused.id);
  if (stealsFromLiveOrchestrator) {
    return {
      action: 'highlight',
      paneId: targetPane.id,
      keptFocusPaneId: focused.id,
    };
  }
  return { action: 'reveal', paneId: targetPane.id };
}

/** Copy pt-BR — visual usa tokens de DESIGN.md; aqui é só texto. */
export function paneRevealToastCopy(
  plan: Exclude<PaneRevealPlan, { action: 'missing' }>,
): {
  readonly kind: 'info';
  readonly title: string;
  readonly detail: string;
} {
  if (plan.action === 'highlight') {
    return {
      kind: 'info',
      title: 'Terminal já aberto',
      detail:
        'Este painel já mostra a sessão. O foco fica no orquestrador para não ' +
        'interromper a mão do operador — role até o painel destacado.',
    };
  }
  return {
    kind: 'info',
    title: 'Terminal já aberto',
    detail:
      'Este agente já tem um painel ativo. Mostramos o existente em vez de ' +
      'abrir outro — cada pane custa memória (F-572).',
  };
}

function revealPaneDom(paneId: string): void {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(paneId)
      : paneId.replace(/["\\]/g, '\\$&');
  const el = document.querySelector<HTMLElement>(
    `[data-pane-id="${escaped}"]`,
  );
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function navigateToPaneSurface(paneId: string): void {
  const layout = useLayoutStore.getState();
  const model = listPanes(layout.root).find((p) => p.id === paneId);
  const navigation = useProductNavigationStore.getState();
  const missionId = model ? attentionMissionIdForPane(model) : undefined;
  if (missionId) {
    navigation.openMission(missionId);
    navigation.showMissionTerminals();
  } else {
    navigation.openTerminal();
  }
}

function liveSessionChecker(): (paneId: string) => boolean {
  const { paneStates } = useSessionStateStore.getState();
  return (paneId: string) =>
    isLivePaneSessionState(paneStates.get(paneId));
}

/**
 * Aplica o plano: navega para a superfície, restaura maximize/stage, foca
 * (ou só destaca) e explica. Devolve o plano para o chamador decidir se
 * ainda precisa nascer um pane novo (`missing`).
 */
export function revealPaneTerminal(target: RevealPaneTarget): PaneRevealPlan {
  const layout = useLayoutStore.getState();
  const panes = listPanes(layout.root);
  const plan = planPaneReveal({
    panes,
    target,
    sessionIdOf: (paneId) => getPaneSessionId(paneId),
    focusedPaneId: layout.focusedPaneId,
    isPaneSessionLive: liveSessionChecker(),
  });
  if (plan.action === 'missing') return plan;

  navigateToPaneSurface(plan.paneId);

  if (plan.action === 'reveal') {
    // `focus` já derruba o maximize de OUTRO pane. Stage Focus precisa do
    // setStagePane: sem ele o alvo continuaria só no rail de cards.
    if (layout.stageFocusMode && layout.stagePaneId !== plan.paneId) {
      layout.setStagePane(plan.paneId);
    } else {
      layout.focus(plan.paneId);
    }
    revealPaneDom(plan.paneId);
  } else {
    // highlight: só destaca/scrolla — o foco do orquestrador fica intacto.
    revealPaneDom(plan.paneId);
  }
  const copy = paneRevealToastCopy(plan);
  useToastStore.getState().push(copy.kind, copy.title, {
    detail: copy.detail,
    dedupeKey: `reveal-pane:${plan.paneId}`,
  });
  return plan;
}
