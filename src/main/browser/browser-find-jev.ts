/**
 * Desempate Jev do `nexus_browser_find` (superfície `browserTool`).
 *
 * O score lexical do `find` empata com frequência em "Salvar" × "Salvar
 * alterações", dois links com o mesmo nome, etc. O código decide QUANDO
 * perguntar (2–5 candidatos no top, scores próximos); o Jev só escolhe
 * entre esses candidatos (+ `none`). Aceite só confiança ≥ 0.7 — abaixo
 * disso o ranking lexical e os `candidates` continuam mandando.
 *
 * FAIL-OPEN: sem chave, superfície off ou `judge()` null → comportamento
 * atual. O `judge` nunca lança; o try/catch aqui cobre deps injetadas.
 */
import type { BrowserFindMatch } from '../../shared/browser-automation';
import { redactBrowserText, redactPageUrl } from '../../shared/browser-redaction';
import type { JevQuestion, JevResult } from '../jev/jev-client';
import { judge, USD_PER_INPUT_TOKEN } from '../jev/jev-client';
import { hasJevCredential } from '../jev/jev-secrets';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';

export const FIND_JEV_MIN_CANDIDATES = 2;
export const FIND_JEV_MAX_CANDIDATES = 5;
/** Diferença aceitável entre o 1º e o 2º score para tratar como empate. */
export const FIND_JEV_MAX_SCORE_GAP = 0.15;
/** Pelo menos dois candidatos precisam parecer reais (score ≥ 0.5). */
export const FIND_JEV_MIN_SCORE = 0.5;
export const FIND_JEV_MIN_CONFIDENCE = 0.7;

// Single attempt (retryOnTimeout:false), see EXTRACT_JUDGE_TIMEOUT_MS.
const FIND_JEV_TIMEOUT_MS = 4_000;
const FIND_JEV_CRITERIA_CHARS = 256;
const FIND_JEV_QUERY_CHARS = 200;
const FIND_JEV_TITLE_CHARS = 256;

function hrefPathOnly(href: string): string {
  try {
    return new URL(href).pathname.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Função pura: o empate do `find` vale só com 2–5 candidatos no top e
 * scores próximos (top-2 com diferença < {@link FIND_JEV_MAX_SCORE_GAP} e
 * ≥ 2 candidatos com score ≥ {@link FIND_JEV_MIN_SCORE}). Fora disso o
 * ranking lexical já decide e o Jev não é consultado.
 */
export function selectFindTieBreakCandidates(
  matches: readonly BrowserFindMatch[],
): BrowserFindMatch[] | null {
  if (
    matches.length < FIND_JEV_MIN_CANDIDATES ||
    matches.length > FIND_JEV_MAX_CANDIDATES
  ) {
    return null;
  }
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  const top = sorted[0]!;
  const second = sorted[1]!;
  if (top.score - second.score >= FIND_JEV_MAX_SCORE_GAP) return null;
  const strong = sorted.filter((m) => m.score >= FIND_JEV_MIN_SCORE);
  if (strong.length < 2) return null;
  return sorted;
}

export interface BrowserFindJevDeps {
  jev?: typeof judge;
  jevEnabled?: () => boolean;
  jevReady?: () => boolean;
  recordDecision?: typeof recordJevDecision;
}

export interface BrowserFindJevContext {
  /** Texto da consulta do `find` (intuito do chamador). */
  query: string;
  pageTitle: string;
  url: string;
  sessionId?: string;
  missionId?: string;
}

export interface BrowserFindJevPick {
  ref: string;
  confidence: number;
}

function buildFindTieBreakQuestion(
  candidates: readonly BrowserFindMatch[],
): JevQuestion {
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) {
    const path = candidate.href ? hrefPathOnly(candidate.href) : '';
    criteria[candidate.ref] =
      `${candidate.role} "${candidate.name}"${path ? ` → ${path}` : ''}`.slice(
        0,
        FIND_JEV_CRITERIA_CHARS,
      );
  }
  criteria.none = 'nenhum corresponde';
  return {
    type: 'choice',
    instructions:
      'These visible elements scored almost the same for the find query. ' +
      'Which one best matches the user intent? Pick none if no candidate corresponds.',
    criteria,
  };
}

/**
 * Uma chamada `judge()` choice entre os candidatos ambíguos (+ `none`).
 * Devolve `{ref, confidence}` só com confiança ≥
 * {@link FIND_JEV_MIN_CONFIDENCE}; `none`, confiança baixa, sem chave,
 * superfície off ou `judge()` null → `null` (fail-open).
 */
export async function pickBrowserFindElement(
  matches: readonly BrowserFindMatch[],
  context: BrowserFindJevContext,
  deps: BrowserFindJevDeps = {},
): Promise<BrowserFindJevPick | null> {
  const candidates = selectFindTieBreakCandidates(matches);
  if (!candidates) return null;

  const judgeFn = deps.jev ?? judge;
  const jevEnabled = deps.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool'));
  const jevReady = deps.jevReady ?? hasJevCredential;
  if (!jevEnabled() || !jevReady()) return null;

  let result: JevResult | null = null;
  try {
    result = await judgeFn({
      state: {
        intent: redactBrowserText(context.query).slice(0, FIND_JEV_QUERY_CHARS),
        pageTitle: redactBrowserText(context.pageTitle).slice(
          0,
          FIND_JEV_TITLE_CHARS,
        ),
        url: redactPageUrl(context.url),
      },
      questions: { element: buildFindTieBreakQuestion(candidates) },
      timeoutMs: FIND_JEV_TIMEOUT_MS,
      retryOnTimeout: false,
      surface: 'browserTool',
      sessionId: context.sessionId,
      missionId: context.missionId,
    });
  } catch {
    return null;
  }
  if (!result) return null;

  const answer = result.answers.element;
  if (!answer || answer.type !== 'choice') return null;

  const record = deps.recordDecision ?? recordJevDecision;
  record({
    surface: 'browserTool',
    sessionId: context.sessionId,
    missionId: context.missionId,
    model: result.model,
    questions: ['element'],
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: answer.choice,
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });

  if (answer.choice === 'none' || answer.confidence < FIND_JEV_MIN_CONFIDENCE) {
    return null;
  }
  const chosen = candidates.find((c) => c.ref === answer.choice);
  if (!chosen) return null;
  return { ref: chosen.ref, confidence: answer.confidence };
}
