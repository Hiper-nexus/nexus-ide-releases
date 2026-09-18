/**
 * Triagem do pedido via TypeSafe Jev (piloto automático, superfície
 * `intake`). UMA chamada `judge()` decide kind/complexidade/risco/
 * ambiguidade/skills/referência de design; a POLÍTICA fica em código —
 * confiança baixa devolve null e o fluxo segue para a cadeia de provedores
 * exatamente como hoje (fail-open em tudo).
 */
import { MISSION_ROUTING_SKILLS } from '../../shared/mission-routing-advice';
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevAnswer,
  type JevQuestion,
  type JevResult,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasJevCredential } from '../jev/jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import { listLocalDesignCatalog } from '../design/local-design-catalog';
import { extractQuestion, type IntentRoute } from './intent-router';

const JEV_INTAKE_TIMEOUT_MS = 6_000;
const KIND_MIN_CONFIDENCE = 0.6;
const SKILL_MIN_PROBABILITY = 0.6;
const DESIGN_REFERENCE_MIN_PROBABILITY = 0.6;

export const JEV_INTAKE_SKILLS: readonly string[] = [
  ...MISSION_ROUTING_SKILLS,
  'typesafe-ai',
];

/** Descrições de uma linha, do vocabulário do ROUTER_SYSTEM_PROMPT. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  impeccable: 'UI/design',
  dembrandt: 'UI/design',
  archify: 'diagramas',
  superpowers: 'planejamento/execução',
  bridgesecurity: 'segurança',
  bridgeward: 'web não confiável',
  'nexus-visual-media': 'mídia',
  'typesafe-ai':
    'typed AI judgments (routing, ranking, verification) inside the software being built',
};

const COMPLEXITY_LEVELS = [
  'trivial',
  'small',
  'medium',
  'large',
] as const;

export type JevComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

export interface IntentTriage {
  source: 'jev';
  model: string;
  complexity: number;
  complexityLevel: JevComplexityLevel;
  complexityConfidence: number;
  riskSensitive: number;
  ambiguous: number;
  designReference?: { name: string; probability: number };
}

export type JevIntentRoute = IntentRoute & { triage?: IntentTriage };

function defaultDesignReferences(): string[] {
  try {
    return listLocalDesignCatalog({}).kits.map((kit) => kit.kitId);
  } catch {
    return [];
  }
}

function noulOf(answers: Record<string, JevAnswer>, id: string): number {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : 0;
}

function buildQuestions(designRefs: string[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    kind: {
      type: 'choice',
      instructions:
        'Classify the user request into exactly one kind.',
      criteria: {
        direct_answer:
          'a general knowledge or trivial question answerable without reading this project\'s files or panes',
        mission_question:
          'a question about THIS project\'s code, panes or state that requires reading the workspace and consolidating an answer',
        mission_work:
          'a real task to build, change, fix, design or configure something',
      },
    },
    complexity: {
      type: 'score',
      instructions: 'Rate the complexity of the requested work.',
      criteria: [
        'trivial: one small change in one place',
        'small: one component or file, clear scope',
        'medium: several files or components, some design decisions',
        'large: multi-part, architectural or cross-cutting',
      ],
    },
    risk_sensitive: {
      type: 'noul',
      instructions:
        'Does the request involve authentication, secrets, payments, ' +
        'deleting data, permissions, sandboxing or spawning processes?',
      criteria: {
        true: 'touches a sensitive area',
        false: 'ordinary low-risk work',
      },
    },
    ambiguous: {
      type: 'noul',
      instructions:
        'Is the request too ambiguous or underspecified to start safely ' +
        'without asking the user at least one clarifying question?',
      criteria: {
        true: 'needs clarification first',
        false: 'clear enough to start',
      },
    },
  };
  for (const skill of JEV_INTAKE_SKILLS) {
    questions[`skill_${skill.replace(/-/g, '_')}`] = {
      type: 'noul',
      instructions:
        `Would the skill \`${skill}\` (${SKILL_DESCRIPTIONS[skill] ?? skill}) ` +
        'materially help this task?',
      criteria: {
        true: 'the skill materially helps',
        false: 'the skill does not materially help',
      },
    };
  }
  if (designRefs.length > 0) {
    const criteria: Record<string, string | null> = {};
    for (const name of designRefs) criteria[name] = null;
    criteria.none = 'no specific visual reference is cited or clearly implied';
    questions.design_reference = {
      type: 'choice',
      instructions:
        'Which visual/design reference does the request cite or clearly imply?',
      criteria,
    };
  }
  return questions;
}

export interface RouteWithJevDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  designReferences?: () => string[];
}

/**
 * Triagem Jev do objetivo. Retorna a rota pronta ou null para o fluxo cair
 * na cadeia de provedores exatamente como antes.
 */
export async function routeWithJev(
  objective: string,
  deps: RouteWithJevDeps = {},
): Promise<JevIntentRoute | null> {
  const judgeFn = deps.judge ?? judge;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('intake'));
  const hasKey = deps.hasKey ?? hasJevCredential;
  const designReferences = deps.designReferences ?? defaultDesignReferences;

  if (!enabled() || !hasKey()) return null;

  const designRefs = designReferences().slice(0, 30);
  const questions = buildQuestions(designRefs);
  const result: JevResult | null = await judgeFn({
    state: { request: capText(objective, 6_000) },
    questions,
    timeoutMs: JEV_INTAKE_TIMEOUT_MS,
    surface: 'intake',
  });
  if (!result) return null;

  const kindAnswer = result.answers.kind;
  if (kindAnswer?.type !== 'choice') return null;
  if (kindAnswer.confidence < KIND_MIN_CONFIDENCE) return null;

  const complexityAnswer = result.answers.complexity;
  const complexity =
    complexityAnswer?.type === 'score' ? complexityAnswer.score : 0;
  const complexityConfidence =
    complexityAnswer?.type === 'score' ? complexityAnswer.confidence : 0;
  const complexityLevel =
    COMPLEXITY_LEVELS[
      Math.min(Math.max(Math.round(complexity), 0), COMPLEXITY_LEVELS.length - 1)
    ];

  const triage: IntentTriage = {
    source: 'jev',
    model: result.model,
    complexity,
    complexityLevel,
    complexityConfidence,
    riskSensitive: noulOf(result.answers, 'risk_sensitive'),
    ambiguous: noulOf(result.answers, 'ambiguous'),
  };
  const designAnswer = result.answers.design_reference;
  if (designAnswer?.type === 'choice' && designAnswer.choice !== 'none') {
    const p = designAnswer.probabilities[designAnswer.choice] ?? 0;
    if (p >= DESIGN_REFERENCE_MIN_PROBABILITY) {
      triage.designReference = { name: designAnswer.choice, probability: p };
    }
  }

  const chosenSkills = JEV_INTAKE_SKILLS.filter(
    (skill) =>
      noulOf(result.answers, `skill_${skill.replace(/-/g, '_')}`) >=
      SKILL_MIN_PROBABILITY,
  );

  let route: JevIntentRoute;
  if (kindAnswer.choice === 'direct_answer') {
    // triage só vai em mission-work: os schemas strict das outras rotas
    // rejeitam a chave extra e derrubariam o parse para deterministic-fallback.
    route = {
      kind: 'direct-answer',
      question: extractQuestion(objective) ?? objective,
    };
  } else if (kindAnswer.choice === 'mission_question') {
    route = {
      kind: 'mission-question',
      question: extractQuestion(objective) ?? objective,
      readOnlyWorkers: true,
    };
  } else {
    route = { kind: 'mission-work', skills: chosenSkills, triage };
  }

  recordJevDecision({
    surface: 'intake',
    model: result.model,
    questions: Object.keys(questions),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: `route:${route.kind}`,
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });
  return route;
}
