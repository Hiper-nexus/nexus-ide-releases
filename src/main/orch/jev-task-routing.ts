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
  type JevResult,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import {
  allowedSkillCatalog,
  buildSkillSuggestionQuestion,
  parseSkillSuggestion,
  type SkillSuggestionPick,
} from './jev-skill-suggestion';
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
 * (segurança/auth/pagamento/dados/produção); difícil = raciocínio profundo
 * entre muitos componentes (arquitetura, refactor grande, performance, race/
 * leak, integração, review sênior de diff/branch/release); médio = trabalho
 * de escopo claro, incluindo mapear/diagnosticar código só lendo; fácil =
 * rename/typo/doc/estilo/log; trivial = consulta/relatório sem julgar código.
 *
 * F-194: o texto anterior mandava 60 de 78 tarefas reais delegadas (25–28/09)
 * para `hard` — mapeamentos e diagnósticos só leitura iam para o tier mais
 * caro. Com este texto o mesmo conjunto dá 32 hard / 39 medium e a confiança
 * ≥ 0.6 sobe de 55 para 59 de 78; o piso de code review
 * (`codeReviewTierFloor`) continua segurando review de código em `hard`.
 */
const TASK_ROUTING_QUESTIONS: Record<string, JevQuestion> = {
  tier: {
    type: 'choice',
    instructions:
      'Classify the complexity and risk tier of this software task so it is routed ' +
      'to the cheapest model that will still do it well. Judge the actual work the ' +
      'task requires, not how the request is worded, how long it is, or how ' +
      'important the project is.',
    criteria: {
      trivial:
        'Only looks something up and reports it: list, read, check, show, count, find ' +
        'a file or value, or run an existing command (tests, lint, build, version ' +
        'check) and report the output. No code changes and no judgment about code: ' +
        'reviewing, verifying or validating a fix, diff, branch, release or review ' +
        'finding is never trivial.',
      easy:
        'Small contained edit with an obvious solution: rename, typo, comment, ' +
        'README/doc text, formatting, lint fix, CSS/style tweak, copy/label/' +
        'translation, adding a log line, bumping a version or config value.',
      medium:
        'Ordinary engineering with clear scope: implement or fix a feature in one or ' +
        'a few files, write or update tests, diagnose one failing test or error, ' +
        'read-only mapping of existing code (find where something is implemented, ' +
        'inventory, explain a flow, list file:line) without designing a new ' +
        'architecture, or checking a few specific review findings or revalidating a ' +
        'small fix. The default when nothing else clearly fits.',
      hard:
        'Deep reasoning across many components: architecture or redesign plans, ' +
        'large refactors, performance optimization, debugging races, leaks or ' +
        'intermittent failures, algorithms, parsers or engines, cross-system ' +
        'integration design, or a senior code review of a whole diff, branch or ' +
        'release (read-only included).',
      critical:
        'Work that causes real damage if done wrong: security, authentication or ' +
        'authorization, secrets, payments or billing, deleting or migrating data, ' +
        'production deploys or infrastructure changes.',
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
 * Parser compartilhado da classificação (tier/especialidade/esforço/escalate):
 * qualquer resposta fora do vocabulário → null (fail-open para a heurística).
 * Usado pelo caminho standalone e pelo lote do route_task.
 */
export function parseTaskClassification(
  result: JevResult,
): JevTaskClassification | null {
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
    return null;
  }
  return {
    tier: tierAnswer.choice,
    tierConfidence: tierAnswer.confidence,
    specialty: specialtyAnswer.choice,
    specialtyConfidence: specialtyAnswer.confidence,
    effort,
    effortConfidence: effort && effortAnswer?.type === 'choice' ? effortAnswer.confidence : undefined,
    escalate: escalateAnswer?.type === 'noul' ? escalateAnswer.noul : 0,
    model: result.model,
  };
}

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
  const hasKey = deps.hasKey ?? (() => hasDecisionCredential('taskRouting'));
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

  const classification = parseTaskClassification(result);
  if (!classification) return { kind: 'unavailable', reason: 'invalid-answer' };
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

/** Metadado interno do lote: quantas chamadas judge e quantas perguntas saíram. */
export interface JevBatchUsageMeta {
  readonly requestCount: number;
  readonly questionCount: number;
}

/**
 * Lote do `nexus_route_task`: classificação (tier/especialidade/esforço/
 * escalate) + sugestão de skill numa ÚNICA chamada judge — as perguntas de
 * roteamento e a choice `skill` (catálogo real filtrado pelos grants do
 * chamador, cap 120 + `none`) vão juntas, e o uso é registrado UMA vez
 * (USD/tokens do resultado único, com sessão/missão). Sem skills elegíveis a
 * pergunta `skill` nem entra. Fail-open idêntico ao standalone: skill `none`,
 * baixa confiança ou escolha fora do catálogo não invalidam a classificação —
 * só viram skillSuggestion null. Resposta malformada nos dois → invalid-answer.
 */
export type JevRouteTaskBatch =
  | {
      readonly kind: 'classified';
      readonly classification: JevTaskClassification;
      readonly skillSuggestion?: SkillSuggestionPick | null;
      readonly batch?: JevBatchUsageMeta;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: JevUnavailableReason;
      readonly skillSuggestion?: SkillSuggestionPick | null;
      readonly batch?: JevBatchUsageMeta;
    }
  | { readonly kind: 'skipped' };

export interface RouteTaskJevBatchDeps extends ClassifyTaskDeps {
  record?: typeof recordJevDecision;
}

export async function classifyTaskWithSkillForRouting(
  task: string,
  opts: {
    allowedSkills: string[] | null;
    sessionId?: string;
    missionId?: string;
    deps?: RouteTaskJevBatchDeps;
  },
): Promise<JevRouteTaskBatch> {
  const noBatch = { requestCount: 0, questionCount: 0 };
  if (!task.trim()) return { kind: 'skipped' };
  const enabled = opts.deps?.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = opts.deps?.hasKey ?? (() => hasDecisionCredential('taskRouting'));
  if (!enabled()) {
    return { kind: 'unavailable', reason: 'disabled', skillSuggestion: null, batch: noBatch };
  }
  if (!hasKey()) {
    return { kind: 'unavailable', reason: 'no-key', skillSuggestion: null, batch: noBatch };
  }

  const catalog = allowedSkillCatalog(opts.allowedSkills);
  const questions: Record<string, JevQuestion> = {
    ...TASK_ROUTING_QUESTIONS,
    ...(catalog.length > 0 ? { skill: buildSkillSuggestionQuestion(catalog) } : {}),
  };
  let noAnswer: JevUnavailableReason | undefined;
  const judgeFn = opts.deps?.judge ?? judge;
  const result = await judgeFn({
    state: { task: capText(task, TASK_MAX_CHARS) },
    questions,
    timeoutMs: TASK_ROUTING_TIMEOUT_MS,
    surface: 'taskRouting',
    sessionId: opts.sessionId,
    missionId: opts.missionId,
    onNoAnswer: (reason) => {
      noAnswer = reason;
    },
  });
  // Logical judge invocations, not successful answers (or HTTP retry count).
  const batch = { requestCount: 1, questionCount: Object.keys(questions).length };
  if (!result) {
    return { kind: 'unavailable', reason: noAnswer ?? 'network', skillSuggestion: null, batch };
  }
  const classification = parseTaskClassification(result);
  const skillSuggestion =
    catalog.length > 0 ? parseSkillSuggestion(result.answers, catalog) : null;
  if (!classification && !skillSuggestion) {
    return { kind: 'unavailable', reason: 'invalid-answer', skillSuggestion: null, batch };
  }
  // Uso do LOTE logado uma única vez — nunca uma linha por operação.
  (opts.deps?.record ?? recordJevDecision)({
    surface: 'taskRouting',
    sessionId: opts.sessionId,
    missionId: opts.missionId,
    model: result.model,
    questions: Object.keys(questions),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: [
      classification
        ? `tier:${classification.tier}/${classification.specialty}`
        : 'tier:invalid',
      `skill:${skillSuggestion?.name ?? 'none'}`,
    ].join('|'),
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
    ...(catalog.length > 0 ? { optimization: { jevRequestsAvoided: 1 } } : {}),
  });
  return classification
    ? { kind: 'classified', classification, skillSuggestion, batch }
    : { kind: 'unavailable', reason: 'invalid-answer', skillSuggestion, batch };
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
