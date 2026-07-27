/**
 * Endorphin Distribution System — copy e batidas do caminho feliz.
 *
 * Princípio: cada superfície tem um "hit" (confirmação, presença ou ritual).
 * Não é gamificação barulhenta: é o operador sentir que o sistema respondeu
 * com vida. Prefer reduced-motion e modo sóbrio continuam válidos na FX.
 */

export type EndorphinBeatId =
  | "boot"
  | "launch"
  | "home-ready"
  | "home-cli"
  | "home-setup"
  | "home-warming"
  | "step-continue"
  | "launch-go"
  | "mission-rail-empty"
  | "mission-rail-active"
  | "settings-nav"
  | "agent-picker-empty"
  | "orch-missions-empty"
  | "orch-handoffs-empty"
  | "orch-todos-empty";

/** Settings — pilares emocionais (YOU / APP / AGENTS / SYSTEM). */
export type SettingsNavPillarId = "you" | "app" | "agents" | "system";

export interface SettingsNavPillar {
  readonly id: SettingsNavPillarId;
  /** Rótulo curto na nav (PT operacional). */
  readonly label: string;
  /** Uma história por grupo — não rótulo de engenharia. */
  readonly story: string;
}

/**
 * Agrupa Settings por quem sou / o cockpit / o que orquestro / saúde.
 * Espelha YOU · APP · AGENTS · SYSTEM da auditoria vibe-coding.
 */
export const SETTINGS_NAV_PILLARS: readonly SettingsNavPillar[] = [
  {
    id: "you",
    label: "Você",
    story: "Conta e voz — quem opera o cockpit",
  },
  {
    id: "app",
    label: "App",
    story: "Aparência, terminal e atalhos",
  },
  {
    id: "agents",
    label: "Agentes",
    story: "Providers, frota e arsenal",
  },
  {
    id: "system",
    label: "Sistema",
    story: "Diagnóstico e saúde do ambiente",
  },
] as const;

export function settingsNavPillar(id: SettingsNavPillarId): SettingsNavPillar {
  const pillar = SETTINGS_NAV_PILLARS.find((entry) => entry.id === id);
  if (!pillar) {
    throw new Error(`Unknown settings nav pillar: ${id}`);
  }
  return pillar;
}

export interface EndorphinBeat {
  readonly id: EndorphinBeatId;
  /** Kicker curto acima do título (opcional). */
  readonly kicker?: string;
  readonly title: string;
  readonly line?: string;
}

function hourBucket(now = new Date()): "dawn" | "day" | "dusk" | "night" {
  const h = now.getHours();
  if (h < 6) return "night";
  if (h < 12) return "dawn";
  if (h < 18) return "day";
  if (h < 22) return "dusk";
  return "night";
}

/** Cumprimento de abertura — muda com o dia, nunca genérico. */
export function bootGreeting(now = new Date()): string {
  switch (hourBucket(now)) {
    case "dawn":
      return "Bom dia, operador";
    case "day":
      return "Sistemas acordando";
    case "dusk":
      return "Turno da tarde";
    case "night":
      return "Noite operacional";
  }
}

export function launchGreeting(now = new Date()): EndorphinBeat {
  switch (hourBucket(now)) {
    case "dawn":
      return {
        id: "launch",
        kicker: "Pronto pra construir",
        title: "Onde a frota começa",
        line: "Escolhe o modo. Um clique e a base abre.",
      };
    case "day":
      return {
        id: "launch",
        kicker: "Mesa limpa",
        title: "Como você quer trabalhar?",
        line: "Terminal puro, missão ou enxame — o fluxo é seu.",
      };
    case "dusk":
      return {
        id: "launch",
        kicker: "Continuar de onde parou",
        title: "De volta ao cockpit",
        line: "Recentes à mão. Lançar sem fricção.",
      };
    case "night":
      return {
        id: "launch",
        kicker: "Foco quieto",
        title: "Sessão noturna",
        line: "Pouca luz, muito sinal. Escolhe o layout e vai.",
      };
  }
}

export function homeReadyBeat(
  cliCount: number,
  toolCount: number,
): EndorphinBeat {
  void cliCount;
  void toolCount;
  return {
    id: "home-ready",
    kicker: "Rota operacional",
    title: "Pronto para planejar",
    line: "Conte o que você quer criar. Sessão, modelo e permissões serão revalidados antes de iniciar cada agente.",
  };
}

export function homeSetupBeat(): EndorphinBeat {
  return {
    id: "home-setup",
    kicker: "Configuração necessária",
    title: "Conclua a rota de execução",
    line: "O Nexus precisa de um Maestro verificado e de um worker autenticado com escrita autônoma confinada.",
  };
}

export function homeWarmingBeat(): EndorphinBeat {
  return {
    id: "home-warming",
    kicker: "Preparando",
    title: "Organizando seu ambiente",
    line: "Só mais um instante para deixar tudo pronto.",
  };
}

export function homeCliBeat(): EndorphinBeat {
  return {
    id: "home-cli",
    kicker: "Primeiro passo",
    title: "Conecte uma IA para começar",
    line: "Escolha uma conta compatível; depois o Nexus cuida da parte técnica.",
  };
}

export const ENDORPHIN_STEP_LABELS = {
  mode: "Modo",
  layout: "Layout",
  agents: "Agentes",
  preview: "Lançar",
} as const;

/** MissionRail vazio — uma história + CTA, não painel lateral morto. */
export function missionRailEmptyBeat(workspaceName: string): EndorphinBeat {
  const name = workspaceName.trim() || "este workspace";
  return {
    id: "mission-rail-empty",
    kicker: "Sala limpa",
    title: "Nenhuma missão aqui",
    line: `Só o trabalho de ${name}. Um clique e a fila acende.`,
  };
}

/** MissionRail com atividade — status narrativo no head. */
export function missionRailActiveBeat(
  activeCount: number,
  totalCount: number,
): EndorphinBeat {
  if (activeCount <= 0) {
    return {
      id: "mission-rail-active",
      kicker: "Na espera",
      title: `${totalCount} na lista`,
      line: "Nada rodando agora — retome ou lance outra.",
    };
  }
  return {
    id: "mission-rail-active",
    kicker: "Em curso",
    title:
      activeCount === 1 ? "1 missão ativa" : `${activeCount} missões ativas`,
    line:
      totalCount === activeCount
        ? "Tudo que importa está no grid."
        : `${totalCount} no total · foque nas ativas.`,
  };
}

/** Agent picker sem CLIs — hangar + CTA Providers. */
export function agentPickerEmptyBeat(): EndorphinBeat {
  return {
    id: "agent-picker-empty",
    kicker: "Hangar vazio",
    title: "Nenhuma CLI na mesa",
    line: "Conecte um provider e o picker acende — sem chave, sem agente.",
  };
}

/** Orquestração · missões vazias. */
export function orchMissionsEmptyBeat(): EndorphinBeat {
  return {
    id: "orch-missions-empty",
    kicker: "Fila limpa",
    title: "Nenhuma missão no radar",
    line: "Lance um squad ou objetivo — o orquestrador despacha os workers.",
  };
}

/** Orquestração · entregas vazias. */
export function orchHandoffsEmptyBeat(): EndorphinBeat {
  return {
    id: "orch-handoffs-empty",
    kicker: "Sem entregas",
    title: "Nada publicado ainda",
    line: "Cada worker reporta aqui assim que conclui a tarefa.",
  };
}

/** Orquestração · tarefas vazias. */
export function orchTodosEmptyBeat(): EndorphinBeat {
  return {
    id: "orch-todos-empty",
    kicker: "Board quieto",
    title: "Sem tarefas no fluxo",
    line: "Aparecem conforme a missão vira passos no orquestrador.",
  };
}
