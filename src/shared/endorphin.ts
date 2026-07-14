/**
 * Endorphin Distribution System — copy e batidas do caminho feliz.
 *
 * Princípio: cada superfície tem um "hit" (confirmação, presença ou ritual).
 * Não é gamificação barulhenta: é o operador sentir que o sistema respondeu
 * com vida. Prefer reduced-motion e modo sóbrio continuam válidos na FX.
 */

export type EndorphinBeatId =
  | 'boot'
  | 'launch'
  | 'home-ready'
  | 'home-cli'
  | 'home-warming'
  | 'step-continue'
  | 'launch-go';

export interface EndorphinBeat {
  readonly id: EndorphinBeatId;
  /** Kicker curto acima do título (opcional). */
  readonly kicker?: string;
  readonly title: string;
  readonly line?: string;
}

function hourBucket(now = new Date()): 'dawn' | 'day' | 'dusk' | 'night' {
  const h = now.getHours();
  if (h < 6) return 'night';
  if (h < 12) return 'dawn';
  if (h < 18) return 'day';
  if (h < 22) return 'dusk';
  return 'night';
}

/** Cumprimento de abertura — muda com o dia, nunca genérico. */
export function bootGreeting(now = new Date()): string {
  switch (hourBucket(now)) {
    case 'dawn':
      return 'Bom dia, operador';
    case 'day':
      return 'Sistemas acordando';
    case 'dusk':
      return 'Turno da tarde';
    case 'night':
      return 'Noite operacional';
  }
}

export function launchGreeting(now = new Date()): EndorphinBeat {
  switch (hourBucket(now)) {
    case 'dawn':
      return {
        id: 'launch',
        kicker: 'Pronto pra construir',
        title: 'Onde a frota começa',
        line: 'Escolhe o modo. Um clique e a base abre.',
      };
    case 'day':
      return {
        id: 'launch',
        kicker: 'Mesa limpa',
        title: 'Como você quer trabalhar?',
        line: 'Terminal puro, missão ou enxame — o fluxo é seu.',
      };
    case 'dusk':
      return {
        id: 'launch',
        kicker: 'Continuar de onde parou',
        title: 'De volta ao cockpit',
        line: 'Recentes à mão. Lançar sem fricção.',
      };
    case 'night':
      return {
        id: 'launch',
        kicker: 'Foco quieto',
        title: 'Sessão noturna',
        line: 'Pouca luz, muito sinal. Escolhe o layout e vai.',
      };
  }
}

export function homeReadyBeat(cliCount: number, toolCount: number): EndorphinBeat {
  return {
    id: 'home-ready',
    kicker: 'Base armada',
    title: 'Você está online',
    line:
      cliCount === 1
        ? `1 CLI pronta · MCP com ${toolCount} ferramentas`
        : `${cliCount} CLIs prontas · MCP com ${toolCount} ferramentas`,
  };
}

export function homeWarmingBeat(): EndorphinBeat {
  return {
    id: 'home-warming',
    kicker: 'Calibrando',
    title: 'Preparando a base',
    line: 'CLIs e MCP ligando — quase lá.',
  };
}

export function homeCliBeat(): EndorphinBeat {
  return {
    id: 'home-cli',
    kicker: 'Falta um clique',
    title: 'Conecte uma CLI e o deck acende',
    line: 'Sem provider a frota fica no hangar.',
  };
}

export const ENDORPHIN_STEP_LABELS = {
  mode: 'Modo',
  layout: 'Layout',
  agents: 'Agentes',
  preview: 'Lançar',
} as const;
