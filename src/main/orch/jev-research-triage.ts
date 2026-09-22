/**
 * Triagem de pesquisa via TypeSafe Jev (superfície `researchTriage`).
 *
 * O search-mixer junta hits de várias fontes e o código faz o merge/rank
 * lexical. O que o código NÃO sabe julgar é o julgamento mesmo: este hit
 * responde à pergunta? Qual é o mais decisivo para uma decisão? Aqui o Jev
 * escolhe o hit mais relevante (choice) e diz se a pergunta já está
 * respondida (noul) — para o agente saber se precisa de outra busca.
 *
 * Doutrina: regra, cálculo e lookup ficam em código. O Jev só julga entre
 * candidatos que o código já levantou. FAIL-OPEN: sem chave, toggle off ou
 * serviço fora → null e o rank lexical continua mandando.
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

export const RESEARCH_TRIAGE_MIN_CONFIDENCE = 0.6;
const RESEARCH_TRIAGE_TIMEOUT_MS = 5_000;
const MAX_HITS = 8;
const HIT_TITLE_MAX = 160;
const HIT_SNIPPET_MAX = 400;
const QUESTION_MAX = 1_000;

export interface ResearchHit {
  /** Identificador do hit (URL, id de documento, etc.). */
  readonly id: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface ResearchTriageResult {
  /** Hit mais decisivo para a pergunta. `null` quando nada é confiável. */
  readonly bestHitId: string | null;
  readonly bestConfidence: number;
  /** true = a pergunta já está respondida por estes hits (noul ≥ limiar). */
  readonly answered: boolean;
  readonly answeredConfidence: number;
  readonly model: string;
  readonly inputTokens: number;
}

const RESEARCH_TRIAGE_ANSWERED: JevQuestion = {
  type: 'noul',
  instructions:
    'Do these research hits together answer the question, or is more ' +
    'research needed?',
  criteria: {
    true: 'the question is answered (or the decision can be made) from these hits',
    false: 'more research is needed — the answer is missing, stale or off-topic',
  },
};

const RESEARCH_TRIAGE_BEST: JevQuestion = {
  type: 'choice',
  instructions:
    'Which of these research hits most directly answers the user\'s question ' +
    'or is most decisive for the decision they are making? Judge the CONTENT, ' +
    'not the wording of the title. Pick `none` when nothing is on-topic.',
  criteria: {},
};

function buildHitCriteria(hits: readonly ResearchHit[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const hit of hits) {
    const label = capText(hit.title ?? hit.id, HIT_TITLE_MAX);
    const body = capText(hit.snippet ?? '', HIT_SNIPPET_MAX);
    criteria[hit.id] = body ? `${label} — ${body}` : label;
  }
  criteria.none = 'Nenhum destes responde à pergunta';
  return criteria;
}

export interface ResearchTriageDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  recordDecision?: typeof recordJevDecision;
}

/**
 * Julga os hits de uma pesquisa. Aceita só o `best_hit` com confiança ≥
 * {@link RESEARCH_TRIAGE_MIN_CONFIDENCE} — abaixo disso, `bestHitId: null` e o
 * chamador continua com o rank lexical. `answered` nunca é negativo por
 * default: noul sem confiança vira `true` (mais pesquisa) só acima do limiar
 * em `false`; incerto = mais pesquisa.
 */
export async function triageResearchHits(
  question: string,
  hits: readonly ResearchHit[],
  sessionId: string,
  missionId: string | undefined,
  deps: ResearchTriageDeps = {},
): Promise<ResearchTriageResult | null> {
  const judgeFn = deps.judge ?? judge;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('researchTriage'));
  const record = deps.recordDecision ?? recordJevDecision;
  if (!enabled() || !hasJevCredential()) return null;
  const usable = hits.filter((hit) => hit.id && hit.id.length > 0).slice(0, MAX_HITS);
  if (usable.length < 2) return null;

  const criteria = buildHitCriteria(usable);
  const result = await judgeFn({
    state: {
      question: capText(question, QUESTION_MAX),
      hits: usable.map((hit) => ({
        id: hit.id,
        title: capText(hit.title ?? '', HIT_TITLE_MAX),
        snippet: capText(hit.snippet ?? '', HIT_SNIPPET_MAX),
      })),
    },
    questions: {
      best_hit: {
        type: 'choice' as const,
        instructions: RESEARCH_TRIAGE_BEST.instructions,
        criteria,
      },
      answered: RESEARCH_TRIAGE_ANSWERED,
    },
    timeoutMs: RESEARCH_TRIAGE_TIMEOUT_MS,
    surface: 'researchTriage',
  });
  if (!result) return null;

  const best = result.answers.best_hit;
  const answered = result.answers.answered;
  const bestId =
    best && best.type === 'choice' && best.choice !== 'none' && best.confidence >= RESEARCH_TRIAGE_MIN_CONFIDENCE
      ? best.choice
      : null;
  // `noul` = P(sim) = "a pergunta está respondida". Incerto (0.4–0.6) conta
  // como "precisa de mais pesquisa" — melhor pedir outro resultado do que
  // fechar a investigação com uma resposta fraca.
  const answeredYes = answered?.type === 'noul' ? answered.noul : 0;

  record({
    surface: 'researchTriage',
    sessionId,
    missionId,
    model: result.model,
    questions: ['best_hit', 'answered'],
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: bestId ?? 'none',
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });

  return {
    bestHitId: bestId,
    bestConfidence: best && best.type === 'choice' ? best.confidence : 0,
    answered: answeredYes >= RESEARCH_TRIAGE_MIN_CONFIDENCE,
    answeredConfidence: jevAnswerConfidences(result.answers).answered ?? 0,
    model: result.model,
    inputTokens: result.usage.input_tokens,
  };
}
