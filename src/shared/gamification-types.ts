/**
 * Gamificação — contratos main/renderer. Princípio: XP = valor entregue,
 * NUNCA consumo de tokens (custo aparece só como estatística/eficiência).
 */

export type GamificationTier =
  | 'RECRUTA'
  | 'INICIADO'
  | 'VETERANO'
  | 'ELITE'
  | 'MAESTRO'
  | 'LENDA';

export type OperatorBranch = 'base' | 'guardiao' | 'forja' | 'scout';

export type XpEventKind =
  | 'mission_green'
  | 'mission_done'
  | 'handoff_green'
  | 'handoff_success'
  | 'task_done'
  | 'media_generated'
  | 'jarvis_action';

/** Entrada pura do engine (a borda resolve effort/custo/evidência antes). */
export interface XpEventInput {
  kind: XpEventKind;
  /** Chave de idempotência: `${kind}:${entityId}` — UNIQUE no SQLite. */
  entityKey: string;
  missionId?: string | null;
  /** Categoria do agente que entregou (ramificação do mascote). */
  agentCategory?: string | null;
  /** Proxy persistido do tier do router (mission_panes.effort). */
  effort?: string | null;
  /** Custo real da missão (tokens+mídia) p/ bônus de eficiência. */
  costUsd?: number | null;
  /** Evidência de verificação (comando + exit 0), quando houver. */
  evidence?: string | null;
  /** Evento do replay retroativo (peso simples, sem evidência/narração). */
  retro?: boolean;
  createdAt: number;
}

export interface StoredXpEvent extends XpEventInput {
  id: number;
  points: number;
  ruleVersion: number;
}

export interface GamificationSnapshot {
  powerLevel: number;
  tier: GamificationTier;
  /** Piso: nunca rebaixa tier já alcançado, mesmo re-score de regras. */
  tierFloor: GamificationTier;
  nextTierAt: number | null;
  prestige: number;
  prestigeReady: boolean;
  branch: OperatorBranch;
  streakDays: number;
  shieldsLeft: number;
  achievements: string[];
  skins: string[];
  selectedSkin: string | null;
  counters: Record<string, number>;
  ruleVersion: number;
}

export const GAMIFICATION_CHANNELS = {
  snapshot: 'gamification:snapshot',
  changed: 'gamification:changed',
  selectSkin: 'gamification:selectSkin',
  exportProfile: 'gamification:export',
  importProfile: 'gamification:import',
  prestige: 'gamification:prestige',
  recordJarvisAction: 'gamification:recordJarvisAction',
} as const;

/** Copy em tokens (i18n desde o dia 1 — PT-BR primeiro). */
export const GAMIFICATION_COPY = {
  tiers: {
    RECRUTA: 'RECRUTA',
    INICIADO: 'INICIADO',
    VETERANO: 'VETERANO',
    ELITE: 'ELITE',
    MAESTRO: 'MAESTRO',
    LENDA: 'LENDA',
  } as Record<GamificationTier, string>,
  branches: {
    base: 'Operador',
    guardiao: 'Guardião',
    forja: 'Forja',
    scout: 'Scout',
  } as Record<OperatorBranch, string>,
  levelUp: (tier: GamificationTier) => `Subiu para ${tier}.`,
  prestigeUp: (stars: number) => `Transcendência ${stars} alcançada.`,
  achievementUnlocked: (title: string) => `Conquista desbloqueada: ${title}.`,
  branchEvolved: (branchName: string) => `Evolução: ${branchName}.`,
  /** id → copy da conquista (renderer nunca importa código do main). */
  achievements: {
    'primeira-missao': { title: 'Primeiro Deploy', description: 'Concluiu a primeira missão.' },
    'primeiro-comando': {
      title: 'Às Ordens',
      description: 'Primeira ação executada pela Jarvis no IDE.',
    },
    'primeira-missao-verde': { title: 'Luz Verde', description: 'Primeira missão concluída com verificação passando.' },
    'primeira-agentica': { title: 'Arquiteto de Times', description: 'Primeira missão criada no modo Agêntico.' },
    'primeira-imagem': { title: 'Pintor Pixel', description: 'Primeira imagem gerada por um agente.' },
    'primeiro-video': { title: 'Diretor', description: 'Primeiro vídeo gerado por um agente.' },
    'primeiro-audio': { title: 'Locutor', description: 'Primeira locução gerada por um agente.' },
    centuriao: { title: 'Centurião', description: '100 handoffs entregues com sucesso.' },
    economico: { title: 'Eficiência de Elite', description: '10 missões fechadas na banda de custo eficiente.' },
    'sequencia-5': { title: 'Ritmo', description: 'Streak de 5 dias úteis entregando.' },
    'sequencia-20': { title: 'Imparável', description: 'Streak de 20 dias úteis entregando.' },
    evolucao: { title: 'Metamorfose', description: 'O mascote evoluiu para um ramo de especialização.' },
    maratona: { title: 'Maratonista', description: '50 missões verdes concluídas.' },
    transcendente: { title: 'Transcendente', description: 'Primeiro prestígio: a jornada recomeça com estrela.' },
  } as Record<string, { title: string; description: string }>,
} as const;
