import type { PaneSessionState } from './types';

/**
 * Linguagem narrativa do estado do pane — chip legível, não só glifo.
 * Compacto o bastante para toolbar densa; tip completo no aria/tooltip.
 */

export interface PaneSessionView {
  readonly state: PaneSessionState;
  /** Chip curto na toolbar (1 palavra). */
  readonly chip: string;
  /** Frase operacional (tooltip / aria). */
  readonly tip: string;
  /** Modificador CSS `toolbar__state--*`. */
  readonly mod: PaneSessionState;
}

/**
 * Durable mission evidence may explain why an already-ended process stopped.
 * Keep this deliberately narrow: a normal exit is not success, and worker
 * prose cannot promote a pane to "concluído".
 */
export interface PaneSessionOutcome {
  readonly outcome?: 'blocked' | 'failed';
}

const VIEWS: Record<PaneSessionState, Omit<PaneSessionView, 'state'>> = {
  idle: {
    // "Pronto" significava DUAS coisas na mesma tela e com a mesma cor:
    // missão entregue e agente parado. Um estado, uma palavra — "Pronto"
    // fica reservado à entrega; o agente parado AGUARDA.
    chip: 'Aguardando',
    tip: 'Agente pronto — aguardando trabalho',
    mod: 'idle',
  },
  busy: {
    // Um estado, uma palavra: a missão em curso já se chama "Trabalhando"
    // (mission-lifecycle-copy). O agente ocupado dizia "Trabalho" —
    // substantivo, e um segundo idioma para o mesmo fato.
    chip: 'Trabalhando',
    tip: 'Agente trabalhando',
    mod: 'busy',
  },
  spawning: {
    chip: 'Sobe',
    tip: 'Agente iniciando',
    mod: 'spawning',
  },
  exited: {
    chip: 'Encerrado',
    tip: 'Sessão encerrada',
    mod: 'exited',
  },
  hibernated: {
    chip: 'Dorme',
    tip: 'Agente em pausa. O histórico está preservado.',
    mod: 'hibernated',
  },
};

export function paneSessionView(
  state: PaneSessionState,
  context: PaneSessionOutcome = {},
): PaneSessionView {
  if (state === 'exited' && context.outcome === 'blocked') {
    return {
      state,
      chip: 'Bloqueado',
      tip: 'Agente encerrou após reportar um bloqueio',
      mod: 'exited',
    };
  }
  if (state === 'exited' && context.outcome === 'failed') {
    return {
      state,
      chip: 'Falhou',
      tip: 'Agente encerrou após reportar uma falha',
      mod: 'exited',
    };
  }
  return { state, ...VIEWS[state] };
}

/** Labels da frota (WorkspaceBar). Palavra inteira — "1 zzz"/"3 trab" era
   críptico para quem não decorou o vocabulário. Se a barra apertar, a
   guarda de overflow da WorkspaceBar desce a densidade (não o chip, que
   continua legível). Espelha o aria-label do FleetChip. */
export const FLEET_SEG_LABEL = {
  working: 'trabalhando',
  ready: 'pronto',
  sleeping: 'dormindo',
  down: 'encerrado',
} as const;
