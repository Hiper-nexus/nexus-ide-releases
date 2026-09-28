/**
 * Classificação de tarefa via TypeSafe Jev para o `nexus_route_task`
 * (piloto automático, superfície `taskRouting`).
 *
 * O router continua dono da decisão (tabela de custo/capacidade, catálogo,
 * reserva, roster). O Jev só troca a HEURÍSTICA de palavras-chave por um
 * julgamento calibrado de tier, especialidade e esforço por turno, cada um
 * aceito só com confiança ≥ 0.6 e caindo para a heurística quando não.
 * `escalate` é um sinal adicional para o Maestro ("isto pede o modelo mais
 * forte ou revisão humana?"), nunca uma decisão. FAIL-OPEN: sem chave,
 * toggle desligado ou serviço fora → null e o router segue como hoje.
 */
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevQuestion,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasJevCredential } from '../jev/jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import {
  isRouteEffort,
  ROUTE_SPECIALTIES,
  type RouteEffort,
  type RouteSpecialty,
} from '../../shared/mission-route-specialty';
import { codeReviewTierFloor, raiseToTierFloor, type TaskTier } from './task-router';
import type { JevUnavailableReason } from '../../shared/spawn-route';

export const TASK_ROUTING_MIN_CONFIDENCE = 0.6;
const TASK_ROUTING_TIMEOUT_MS = 5_000;
const TASK_MAX_CHARS = 3_000;

const TIERS: readonly TaskTier[] = ['trivial', 'easy', 'medium', 'hard', 'critical'];

/**
 * Semântica alinhada à heurística de task-router.ts: crítico = risco
 * (segurança/auth/pagamento/dados/produção); difícil = arquitetura, refactor,
 * performance, debug, integração; fácil = rename/typo/doc/estilo/log;
 * trivial = inspeção (listar, ler, verificar, mostrar); médio = o resto.
 */
const TASK_ROUTING_QUESTIONS: Record<string, JevQuestion> = {
  tier: {
    type: 'choice',
    instructions:
      'Classify the complexity and risk tier of this software task for routing ' +
      'it to a model. Judge the WORK, not the wording.',
    criteria: {
      trivial:
        'inspection only: list, read, check, show, count, find a file — no code changes ' +
        'and no code review (reviewing a diff, branch or release is hard, even read-only)',
      easy:
        'small contained edit: rename, typo, comment, README/doc text, formatting, ' +
        'lint, CSS/style tweak, copy/label/translation, adding a log line',
      medium:
        'ordinary implementation: a feature or fix touching one or a few files ' +
        'with clear scope and no special risk (the default when nothing else fits)',
      hard:
        'architecture, refactor or redesign, performance/optimization, debugging ' +
        'a race or leak, algorithms, parsers/compilers/engines, system or ' +
        'protocol design, cross-system integration, senior code review of a diff, ' +
        'branch or release (read-only included)',
      critical:
        'risk-bearing work: security, authentication/authorization, secrets, ' +
        'payments/billing, deleting or migrating data, production/deploy changes',
    },
  },
  specialty: {
    type: 'choice',
    instructions: 'Which work specialty best describes this task?',
    criteria: {
      visual: 'UI, layout, design, styling, components, screens — what the user sees',
      security: 'auth, permissions, secrets, sandboxing, vulnerabilities, hardening',
      bug: 'something that used to work is broken or behaves wrong; fix it',
      feature: 'new capability or behavior that does not exist yet',
      doc: 'documentation, comments, README, guides, explanations',
      ops: 'build, deploy, CI, infrastructure, servers, environments, releases',
      general: 'none of the above clearly applies or the task mixes several',
    },
  },
  effort: {
    type: 'choice',
    instructions:
      'Choose the reasoning effort needed per turn to complete this software task reliably. ' +
      'Judge the actual reasoning work, independently of the work specialty, project importance, ' +
      'prompt length or model/provider. Choose the lowest effort that can solve it; mentioning ' +
      'auth, security or deployment does not by itself require deep reasoning.',
    criteria: {
      low: 'Mechanical inspection or a small obvious edit with an established solution: ' +
        'lookup, list, typo, rename, one-line fix, documentation or label change.',
      medium: 'Ordinary scoped implementation or diagnosis using established patterns; ' +
        'a few related files and straightforward checks, without subtle cross-system interactions.',
      high: 'Subtle debugging, architecture, algorithms or changes with interacting constraints ' +
        'across components; requires tracing alternatives and checking non-obvious failure modes.',
      xhigh: 'Exceptionally difficult or ambiguous reasoning with multiple coupled systems and ' +
        'serious failure consequences; deep design, adversarial analysis or complex recovery ' +
        'where high effort is insufficient.',
    },
  },
  escalate: {
    type: 'noul',
    instructions:
      'Does this task warrant the strongest available model or human review ' +
      'because of risk, ambiguity or subtlety?',
    criteria: {
      true: 'high stakes or genuinely subtle — strongest model or a human should look',
      false: 'routine — a cost-efficient model is fine',
    },
  },
};

export interface JevTaskClassification {
  tier: TaskTier;
  tierConfidence: number;
  specialty: RouteSpecialty;
  specialtyConfidence: number;
  effort?: RouteEffort;
  effortConfidence?: number;
  escalate: number;
  model: string;
}

export interface ClassifyTaskDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
}

function isTier(value: string): value is TaskTier {
  return (TIERS as readonly string[]).includes(value);
}

function isSpecialty(value: string): value is RouteSpecialty {
  return (ROUTE_SPECIALTIES as readonly string[]).includes(value);
}

export type JevTaskRoutingResult =
  | { readonly kind: 'classified'; readonly classification: JevTaskClassification }
  | { readonly kind: 'unavailable'; readonly reason: JevUnavailableReason }
  | { readonly kind: 'skipped' };

/**
 * Classificação para o roteador COM o motivo quando o Jev não respondeu — o
 * spawn da mão do operador mostra "sem Jev: <motivo>" em vez de cair calado na
 * heurística. `skipped` = tarefa em branco, nada a julgar e nada a avisar.
 */
export async function classifyTaskForRouting(
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<JevTaskRoutingResult> {
  if (!task.trim()) return { kind: 'skipped' };
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = deps.hasKey ?? hasJevCredential;
  if (!enabled()) return { kind: 'unavailable', reason: 'disabled' };
  if (!hasKey()) return { kind: 'unavailable', reason: 'no-key' };

  let noAnswer: JevUnavailableReason | undefined;
  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { task: capText(task, TASK_MAX_CHARS) },
    questions: TASK_ROUTING_QUESTIONS,
    timeoutMs: TASK_ROUTING_TIMEOUT_MS,
    surface: 'taskRouting',
    onNoAnswer: (reason) => {
      noAnswer = reason;
    },
  });
  if (!result) return { kind: 'unavailable', reason: noAnswer ?? 'network' };

  const tierAnswer = result.answers.tier;
  const specialtyAnswer = result.answers.specialty;
  const escalateAnswer = result.answers.escalate;
  const effortAnswer = result.answers.effort;
  const effort = effortAnswer?.type === 'choice' && isRouteEffort(effortAnswer.choice)
    ? effortAnswer.choice : undefined;
  if (
    tierAnswer?.type !== 'choice' ||
    specialtyAnswer?.type !== 'choice' ||
    !isTier(tierAnswer.choice) ||
    !isSpecialty(specialtyAnswer.choice)
  ) {
    return { kind: 'unavailable', reason: 'invalid-answer' };
  }

  const classification: JevTaskClassification = {
    tier: tierAnswer.choice,
    tierConfidence: tierAnswer.confidence,
    specialty: specialtyAnswer.choice,
    specialtyConfidence: specialtyAnswer.confidence,
    effort,
    effortConfidence: effort && effortAnswer?.type === 'choice' ? effortAnswer.confidence : undefined,
    escalate: escalateAnswer?.type === 'noul' ? escalateAnswer.noul : 0,
    model: result.model,
  };
  recordJevDecision({
    surface: 'taskRouting',
    model: result.model,
    questions: Object.keys(TASK_ROUTING_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: `tier:${classification.tier}/${classification.specialty}`,
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });
  return { kind: 'classified', classification };
}

/** Contrato antigo (classificação ou null) — mantido para os chamadores atuais. */
export async function classifyTaskWithJev(
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<JevTaskClassification | null> {
  const result = await classifyTaskForRouting(task, deps);
  return result.kind === 'classified' ? result.classification : null;
}

export type ClassifierSource = 'jev' | 'heuristic' | 'mixed';

/**
 * Aplica o limiar por campo: cada dimensão só substitui a heurística quando
 * o Jev está confiante nela. Devolve os overrides e a proveniência combinada.
 */
export function routingOverridesFrom(
  classification: JevTaskClassification | null,
  callerTier: TaskTier | undefined,
  /**
   * Texto da tarefa: revisão de código tem piso hard também sobre o tier do
   * Jev (27/09: "revisão sênior, somente leitura" virou trivial → grok low e
   * a política de modelos de topo nem foi consultada). O tier do CHAMADOR
   * continua mandando.
   */
  taskText?: string,
): {
  tierOverride: TaskTier | undefined;
  specialtyOverride: RouteSpecialty | undefined;
  effortOverride: RouteEffort | undefined;
  classifierSource: ClassifierSource;
  escalate: number | undefined;
} {
  if (!classification) {
    return {
      tierOverride: callerTier,
      specialtyOverride: undefined,
      effortOverride: undefined,
      classifierSource: 'heuristic',
      escalate: undefined,
    };
  }
  const tierFromJev =
    callerTier === undefined &&
    classification.tierConfidence >= TASK_ROUTING_MIN_CONFIDENCE;
  const specialtyFromJev =
    classification.specialtyConfidence >= TASK_ROUTING_MIN_CONFIDENCE;
  const effortFromJev = isRouteEffort(classification.effort) &&
    (classification.effortConfidence ?? 0) >= TASK_ROUTING_MIN_CONFIDENCE;
  const usedJev = Number(tierFromJev) + Number(specialtyFromJev) + Number(effortFromJev);
  return {
    tierOverride:
      callerTier ??
      (tierFromJev
        ? raiseToTierFloor(classification.tier, taskText ? codeReviewTierFloor(taskText) : null)
        : undefined),
    specialtyOverride: specialtyFromJev ? classification.specialty : undefined,
    effortOverride: effortFromJev ? classification.effort : undefined,
    classifierSource: usedJev === 3 ? 'jev' : usedJev > 0 ? 'mixed' : 'heuristic',
    escalate: classification.escalate,
  };
}
