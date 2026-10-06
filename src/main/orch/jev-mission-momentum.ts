/**
 * Julgamento do momentum da missão via TypeSafe Jev (superfície
 * `missionMomentum`). O watchdog mecânico deteta o candidato (solo 20 min,
 * backlog pronto); o Jev decide se está PRESO, devagar, em gate longo ou se
 * recuperando — e qual a ação certa. É o "usar o Jev de verdade" no motor:
 * a regra mecânica é o gate (rápido, gratuito), o Jev é o juiz que refina a
 * ação quando a situação é ambígua.
 *
 * FAIL-OPEN em tudo: sem chave, autopilot desligado, timeout ou `judge()`
 * null → a decisão mecânica vale exatamente como antes.
 */
import { decisionResultUsage } from '../decision-models/decision-usage';
import {
  capText,
  judge,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

export const JEV_MOMENTUM_TIMEOUT_MS = 6_000;
/** Confiança mínima para o Jev substituir a ação mecânica. */
export const MOMENTUM_MIN_CONFIDENCE = 0.6;

export type MomentumJudgment =
  | 'stuck'
  | 'progressing'
  | 'waiting-gate'
  | 'recovering';

export type MomentumAction =
  | 'open-workers'
  | 'wait-gate'
  | 'escalate-operator'
  | 'nudge-maestro';

export interface MissionMomentumFacts {
  readonly missionId: string;
  readonly missionStatus: string;
  /** Workers vivos na missão (0 = solo). */
  readonly workerPanes: number;
  /** Tarefas registradas prontas para despacho. */
  readonly readyTaskIds: readonly string[];
  /** Vagas do orçamento da missão. */
  readonly availableSlots: number;
  /** Há quanto tempo a missão está sem worker (null = tem worker). */
  readonly soloForMs: number | null;
  /** Há quanto tempo as tarefas prontas estão paradas (null = sem backlog). */
  readonly readyForMs: number | null;
  /** Comandos pesados nesta missão; null quando não medido. */
  readonly heavyCommandsActive: number | null;
  /** Handoffs recentes (últimos 10 min); null quando não medido. */
  readonly recentHandoffs: number | null;
  /** Sessão do Maestro viva. */
  readonly orchestratorAlive: boolean;
}

export interface MissionMomentumVerdict {
  readonly kind: 'skipped' | 'judged';
  readonly reason?: string;
  readonly judgment?: MomentumJudgment;
  readonly action?: MomentumAction;
  readonly confidence?: number;
  readonly model?: string;
  readonly probabilities?: Record<string, number>;
}

/**
 * State compacto (≤ 2 KB) para o Jev. Só números e fatos curtos — nunca o
 * texto das tarefas nem o conteúdo dos handoffs.
 */
function buildState(facts: MissionMomentumFacts): string {
  return capText(
    JSON.stringify({
      missionStatus: facts.missionStatus,
      workerPanes: facts.workerPanes,
      readyTasks: facts.readyTaskIds.length,
      availableSlots: facts.availableSlots,
      soloMinutes: facts.soloForMs === null ? null : Math.round(facts.soloForMs / 60_000),
      readyMinutes: facts.readyForMs === null ? null : Math.round(facts.readyForMs / 60_000),
      heavyCommands: facts.heavyCommandsActive,
      recentHandoffs: facts.recentHandoffs,
      orchestratorAlive: facts.orchestratorAlive,
    }),
    2_000,
  );
}

export const MISSION_MOMENTUM_QUESTIONS: Record<string, JevQuestion> = {
  is_stuck: {
    type: 'noul',
    instructions:
      'Is this mission actually STUCK (no useful work is progressing and ' +
      'nothing is about to) versus waiting for a long-running gate, delivering ' +
      'a handoff, or already recovering? A long validation running counts as ' +
      'progressing. Zero workers for a while with ready tasks and free slots ' +
      'is stuck. Workers present with recent handoffs is progressing.',
    criteria: {
      true: 'mission is stuck: no work progressing, ready backlog, free slots, no gate running',
      false: 'progressing, waiting on a gate, delivering, or recovering',
    },
  },
  best_action: {
    type: 'choice',
    instructions:
      'What should the orchestrator do next to keep the mission moving?',
    criteria: {
      'open-workers':
        'ready tasks exist and slots are free — open workers for the independent pieces now',
      'wait-gate':
        'a long validation or build is running; independent work cannot advance before it finishes',
      'escalate-operator':
        'the mission needs the operator (blocked on a decision, permission, or external dependency)',
      'nudge-maestro':
        'the orchestrator is idle or lost focus; remind it of the next unit of work',
    },
  },
  urgency: {
    type: 'score',
    instructions:
      'How urgent is it to act on this momentum signal?',
    criteria: [
      '0: no action needed — work is flowing',
      '1: low — minor idle, will self-correct',
      '2: medium — backlog is forming, nudge is enough',
      '3: high — mission is losing time, open workers or escalate',
      '4: critical — mission is wedged, immediate intervention',
    ],
  },
};

function noulOf(answers: Record<string, JevAnswer>, id: string): number | null {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : null;
}

function choiceOf(
  answers: Record<string, JevAnswer>,
  id: string,
): { choice: string; confidence: number } | null {
  const a = answers[id];
  return a && a.type === 'choice'
    ? { choice: a.choice, confidence: a.confidence }
    : null;
}

/**
 * Regras determinísticas sobre as probabilidades do Jev. A POLÍTICA fica em
 * código — o Jev julga, o código decide o que fazer com o julgamento.
 */
export function evaluateMomentumJudgment(
  answers: Record<string, JevAnswer>,
): {
  judgment: MomentumJudgment;
  action: MomentumAction;
  confidence: number;
} {
  const stuck = noulOf(answers, 'is_stuck');
  const choice = choiceOf(answers, 'best_action');

  // Sem resposta clara: preserva a ação mecânica (nudge).
  if (stuck === null && !choice) {
    return { judgment: 'progressing', action: 'nudge-maestro', confidence: 0 };
  }

  const judgment: MomentumJudgment =
    stuck !== null && stuck >= 0.5
      ? 'stuck'
      : choice?.choice === 'wait-gate'
        ? 'waiting-gate'
        : choice?.choice === 'escalate-operator'
          ? 'recovering'
          : 'progressing';

  const action: MomentumAction = choice?.choice
    ? (choice.choice as MomentumAction)
    : stuck !== null && stuck >= 0.7
      ? 'open-workers'
      : 'nudge-maestro';

  const confidence = choice?.confidence ?? stuck ?? 0;
  return { judgment, action, confidence };
}

/**
 * Julga o momentum da missão. Fail-open: sem credencial, superfície
 * desligada, timeout ou erro → `{ kind: 'skipped' }` e a decisão mecânica
 * continua valendo.
 */
export async function judgeMissionMomentum(
  facts: MissionMomentumFacts,
  options?: {
    readonly signal?: AbortSignal;
    readonly now?: () => number;
  },
): Promise<MissionMomentumVerdict> {
  if (!isJevSurfaceEnabled('missionMomentum')) {
    return { kind: 'skipped', reason: 'surface-disabled' };
  }
  if (!hasDecisionCredential('missionMomentum')) {
    return { kind: 'skipped', reason: 'no-credential' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_MOMENTUM_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  const state = buildState(facts);
  let result: JevResult | null = null;
  try {
    result = await judge(
      {
        state,
        questions: MISSION_MOMENTUM_QUESTIONS,
        surface: 'missionMomentum',
        missionId: facts.missionId,
        signal,
      },
    );
  } catch {
    result = null;
  } finally {
    clearTimeout(timer);
  }

  if (!result) {
    return { kind: 'skipped', reason: 'no-answer' };
  }

  const verdict = evaluateMomentumJudgment(result.answers);
  if (verdict.confidence < MOMENTUM_MIN_CONFIDENCE) {
    return {
      kind: 'skipped',
      reason: 'low-confidence',
      model: result.model,
      probabilities: jevAnswerProbabilities(result.answers),
    };
  }

  const probabilities = jevAnswerProbabilities(result.answers);
  try {
    recordJevDecision({
      surface: 'missionMomentum',
      missionId: facts.missionId,
      model: result.model,
      questions: Object.keys(MISSION_MOMENTUM_QUESTIONS),
      probabilities,
      decision: verdict.action,
      ...decisionResultUsage(result),
    });
  } catch {
    // Diário nunca bloqueia.
  }

  return {
    kind: 'judged',
    judgment: verdict.judgment,
    action: verdict.action,
    confidence: verdict.confidence,
    model: result.model,
    probabilities,
  };
}

/**
 * Texto do nudge refinado pelo julgamento. Sem julgamento, o texto mecânico
 * original do momentum watchdog vale.
 */
export function momentumNudgeFromJudgment(
  verdict: MissionMomentumVerdict,
  mechanicalText: string,
): string {
  if (verdict.kind !== 'judged') return mechanicalText;
  switch (verdict.action) {
    case 'wait-gate':
      return (
        mechanicalText + '\n\n' + 'Jev sugere conferir se há um gate longo: ' +
        'não abra workers para o mesmo validador. Continue o trabalho independente ' +
        'que não depende do gate (planejar, revisar, documentar).'
      );
    case 'escalate-operator':
      return (
        mechanicalText + '\n\n[momentum:escalate] Jev sugere conferir se falta uma decisão do operador.'
      );
    case 'open-workers':
      return mechanicalText;
    case 'nudge-maestro':
    default:
      return mechanicalText;
  }
}
