/**
 * Classificação de tarefa via TypeSafe Jev para o `nexus_route_task`
 * (piloto automático, superfície `taskRouting`).
 *
 * O router continua dono da decisão (tabela de custo/capacidade, catálogo,
 * reserva, roster). O Jev só troca a HEURÍSTICA de palavras-chave por um
 * julgamento calibrado em dois campos — tier e especialidade —, cada um
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
  ROUTE_SPECIALTIES,
  type RouteSpecialty,
} from '../../shared/mission-route-specialty';
import type { TaskTier } from './task-router';

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
        'inspection only: list, read, check, show, count, find a file — no code changes',
      easy:
        'small contained edit: rename, typo, comment, README/doc text, formatting, ' +
        'lint, CSS/style tweak, copy/label/translation, adding a log line',
      medium:
        'ordinary implementation: a feature or fix touching one or a few files ' +
        'with clear scope and no special risk (the default when nothing else fits)',
      hard:
        'architecture, refactor or redesign, performance/optimization, debugging ' +
        'a race or leak, algorithms, parsers/compilers/engines, system or ' +
        'protocol design, cross-system integration',
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

export async function classifyTaskWithJev(
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<JevTaskClassification | null> {
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = deps.hasKey ?? hasJevCredential;
  if (!task.trim() || !enabled() || !hasKey()) return null;

  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { task: capText(task, TASK_MAX_CHARS) },
    questions: TASK_ROUTING_QUESTIONS,
    timeoutMs: TASK_ROUTING_TIMEOUT_MS,
  });
  if (!result) return null;

  const tierAnswer = result.answers.tier;
  const specialtyAnswer = result.answers.specialty;
  const escalateAnswer = result.answers.escalate;
  if (
    tierAnswer?.type !== 'choice' ||
    specialtyAnswer?.type !== 'choice' ||
    !isTier(tierAnswer.choice) ||
    !isSpecialty(specialtyAnswer.choice)
  ) {
    return null;
  }

  const classification: JevTaskClassification = {
    tier: tierAnswer.choice,
    tierConfidence: tierAnswer.confidence,
    specialty: specialtyAnswer.choice,
    specialtyConfidence: specialtyAnswer.confidence,
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
  return classification;
}

export type ClassifierSource = 'jev' | 'heuristic' | 'mixed';

/**
 * Aplica o limiar por campo: cada dimensão só substitui a heurística quando
 * o Jev está confiante nela. Devolve os overrides e a proveniência combinada.
 */
export function routingOverridesFrom(
  classification: JevTaskClassification | null,
  callerTier: TaskTier | undefined,
): {
  tierOverride: TaskTier | undefined;
  specialtyOverride: RouteSpecialty | undefined;
  classifierSource: ClassifierSource;
  escalate: number | undefined;
} {
  if (!classification) {
    return {
      tierOverride: callerTier,
      specialtyOverride: undefined,
      classifierSource: 'heuristic',
      escalate: undefined,
    };
  }
  const tierFromJev =
    callerTier === undefined &&
    classification.tierConfidence >= TASK_ROUTING_MIN_CONFIDENCE;
  const specialtyFromJev =
    classification.specialtyConfidence >= TASK_ROUTING_MIN_CONFIDENCE;
  const usedJev = Number(tierFromJev) + Number(specialtyFromJev);
  return {
    tierOverride: callerTier ?? (tierFromJev ? classification.tier : undefined),
    specialtyOverride: specialtyFromJev ? classification.specialty : undefined,
    classifierSource: usedJev === 2 ? 'jev' : usedJev === 1 ? 'mixed' : 'heuristic',
    escalate: classification.escalate,
  };
}
