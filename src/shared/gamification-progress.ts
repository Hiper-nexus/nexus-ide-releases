/**
 * Progresso de conquistas e "quests" do Operador — puro, usável no renderer
 * sem importar o main. Endorfina = progresso visível, não só "Bloqueada".
 *
 * KEEP IN SYNC with `src/main/gamification/achievements.ts` thresholds.
 * Meters here are display-only; unlock authority stays in the main service.
 */

import type {
  GamificationSnapshot,
  GamificationTier,
  OperatorBranch,
  XpEventKind,
} from './gamification-types';
import { GAMIFICATION_COPY } from './gamification-types';

export type AchievementProgress = {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  current: number;
  target: number;
  /** 0..1 */
  ratio: number;
};

export type OperatorQuest = {
  id: string;
  title: string;
  hint: string;
  current: number;
  target: number;
  ratio: number;
  rewardHint: string;
};

const XP_KIND_LABEL: Record<XpEventKind, string> = {
  mission_green: 'Missão verde',
  mission_done: 'Missão concluída',
  handoff_green: 'Handoff verificado',
  handoff_success: 'Handoff entregue',
  task_done: 'Task concluída',
  media_generated: 'Mídia gerada',
  jarvis_action: 'Ação da Jarvis',
  agent_turn: 'Turno de agente',
};

export function xpKindLabel(kind: XpEventKind): string {
  return XP_KIND_LABEL[kind] ?? kind;
}

function count(counters: Record<string, number>, key: string): number {
  return counters[key] ?? 0;
}

function ratio(current: number, target: number): number {
  if (target <= 0) return 1;
  return Math.max(0, Math.min(1, current / target));
}

type ProgressCtx = {
  counters: Record<string, number>;
  streakDays: number;
  prestige: number;
  branch: OperatorBranch | string;
};

/** current/target por conquista — espelha achievements.ts do main. */
export function achievementMeter(
  id: string,
  ctx: ProgressCtx,
): { current: number; target: number } {
  const c = (key: string) => count(ctx.counters, key);
  switch (id) {
    case 'primeira-missao':
      return { current: c('mission_done') + c('mission_green'), target: 1 };
    case 'primeiro-comando':
      return { current: c('jarvis_action'), target: 1 };
    case 'primeira-missao-verde':
      return { current: c('mission_green'), target: 1 };
    case 'primeira-agentica':
      return { current: c('agentic_mission'), target: 1 };
    case 'primeira-imagem':
      return { current: c('media_image'), target: 1 };
    case 'primeiro-video':
      return { current: c('media_video'), target: 1 };
    case 'primeiro-audio':
      return { current: c('media_audio'), target: 1 };
    case 'centuriao':
      return {
        current: c('handoff_green') + c('handoff_success'),
        target: 100,
      };
    case 'economico':
      return { current: c('efficient_mission'), target: 10 };
    case 'sequencia-5':
      return { current: ctx.streakDays, target: 5 };
    case 'sequencia-20':
      return { current: ctx.streakDays, target: 20 };
    case 'evolucao':
      return { current: ctx.branch !== 'base' ? 1 : 0, target: 1 };
    case 'maratona':
      return { current: c('mission_green'), target: 50 };
    case 'transcendente':
      return { current: ctx.prestige, target: 1 };
    default:
      return { current: 0, target: 1 };
  }
}

export function listAchievementProgress(
  snapshot: Pick<
    GamificationSnapshot,
    'achievements' | 'counters' | 'streakDays' | 'prestige' | 'branch'
  >,
): AchievementProgress[] {
  const unlocked = new Set(snapshot.achievements);
  const ctx: ProgressCtx = {
    counters: snapshot.counters,
    streakDays: snapshot.streakDays,
    prestige: snapshot.prestige,
    branch: snapshot.branch,
  };
  return Object.entries(GAMIFICATION_COPY.achievements).map(([id, copy]) => {
    const meter = achievementMeter(id, ctx);
    const isUnlocked = unlocked.has(id);
    const current = isUnlocked
      ? Math.max(meter.current, meter.target)
      : meter.current;
    return {
      id,
      title: copy.title,
      description: copy.description,
      unlocked: isUnlocked,
      current,
      target: meter.target,
      ratio: isUnlocked ? 1 : ratio(current, meter.target),
    };
  });
}

/**
 * Quests de gancho — o que fazer AGORA para sentir o sistema viver.
 * Ordenadas do mais fácil ao mais ambicioso; máx. 3.
 */
export function activeOperatorQuests(
  snapshot: Pick<
    GamificationSnapshot,
    'counters' | 'streakDays' | 'powerLevel' | 'achievements' | 'branch'
  >,
): OperatorQuest[] {
  const c = (key: string) => count(snapshot.counters, key);
  const unlocked = new Set(snapshot.achievements);
  const quests: OperatorQuest[] = [];

  const push = (quest: OperatorQuest) => {
    if (quest.ratio >= 1) return;
    quests.push(quest);
  };

  push({
    id: 'quest-agent-turn',
    title: 'Primeira entrega de agente',
    hint: 'Rode Claude ou Codex num pane até ele responder com saída real.',
    current: c('agent_turn'),
    target: 1,
    ratio: ratio(c('agent_turn'), 1),
    rewardHint: '+300 XP por turno',
  });

  push({
    id: 'quest-jarvis',
    title: 'Dar uma ordem à Jarvis',
    hint: 'Use a voz ou um comando da Jarvis no IDE (abrir terminal, focar pane…).',
    current: c('jarvis_action'),
    target: 1,
    ratio: ratio(c('jarvis_action'), 1),
    rewardHint: 'Conquista “Às Ordens”',
  });

  push({
    id: 'quest-mission',
    title: 'Fechar uma missão',
    hint: 'Conclua uma missão (status done). Verde se houver handoff verificado.',
    current: c('mission_done') + c('mission_green'),
    target: 1,
    ratio: ratio(c('mission_done') + c('mission_green'), 1),
    rewardHint: '10K–25K XP + Primeiro Deploy',
  });

  if (!unlocked.has('primeira-missao-verde')) {
    push({
      id: 'quest-green',
      title: 'Missão com luz verde',
      hint: 'Entregue com evidência nexus-trusted (handoff verificado).',
      current: c('mission_green'),
      target: 1,
      ratio: ratio(c('mission_green'), 1),
      rewardHint: 'Conquista “Luz Verde”',
    });
  }

  if (snapshot.streakDays < 5) {
    push({
      id: 'quest-streak',
      title: 'Manter o ritmo',
      hint: 'Entregue em dias úteis seguidos. Escudos cobrem 2 faltas/mês.',
      current: snapshot.streakDays,
      target: 5,
      ratio: ratio(snapshot.streakDays, 5),
      rewardHint: 'Conquista “Ritmo”',
    });
  }

  return quests.slice(0, 3);
}

/**
 * Piso de cada tier — KEEP IN SYNC with main xp-rules TIER_THRESHOLDS.
 * Progresso da barra é DENTRO do tier atual, não power/next absoluto.
 */
const TIER_FLOOR: Record<GamificationTier, number> = {
  RECRUTA: 0,
  INICIADO: 100_000,
  VETERANO: 400_000,
  ELITE: 1_500_000,
  MAESTRO: 6_000_000,
  LENDA: 25_000_000,
};

export function tierProgress(snapshot: {
  powerLevel: number;
  nextTierAt: number | null;
  tier: GamificationTier;
}): {
  ratio: number;
  remaining: number | null;
  label: string;
} {
  if (snapshot.nextTierAt === null) {
    return { ratio: 1, remaining: null, label: 'Topo da jornada' };
  }
  const floor = TIER_FLOOR[snapshot.tier] ?? 0;
  const span = Math.max(1, snapshot.nextTierAt - floor);
  const within = Math.max(0, snapshot.powerLevel - floor);
  const remaining = Math.max(0, snapshot.nextTierAt - snapshot.powerLevel);
  const ratio = Math.min(1, within / span);
  return {
    ratio,
    remaining,
    label: `${GAMIFICATION_COPY.tiers[snapshot.tier]} → próximo marco`,
  };
}
