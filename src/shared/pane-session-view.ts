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

const VIEWS: Record<PaneSessionState, Omit<PaneSessionView, 'state'>> = {
  idle: {
    chip: 'Pronto',
    tip: 'Agente pronto — aguardando trabalho',
    mod: 'idle',
  },
  busy: {
    chip: 'Trabalho',
    tip: 'Agente trabalhando',
    mod: 'busy',
  },
  spawning: {
    chip: 'Sobe',
    tip: 'Agente iniciando',
    mod: 'spawning',
  },
  exited: {
    chip: 'Morto',
    tip: 'Processo encerrado — use Reiniciar',
    mod: 'exited',
  },
  hibernated: {
    chip: 'Dorme',
    tip: 'Agente hibernado — use Acordar',
    mod: 'hibernated',
  },
};

export function paneSessionView(state: PaneSessionState): PaneSessionView {
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
  down: 'morto',
} as const;
