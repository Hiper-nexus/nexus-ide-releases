/**
 * Desempate de missão falada pelo Jev (superfície `missionPick`).
 *
 * "Abre a missão site da loja" com "Site da loja" e "Site da loja v2" salvas é
 * ambíguo: o resolvedor local (`shared/mission-name-match`) não escolhe, e esta
 * função faz UMA pergunta `choice` ao modelo de decisão — um candidato ou
 * `none`. A decisão só vale com confiança ≥ 0,7 E margem ≥ 0,15 sobre a 2ª
 * opção (contando o `none`); qualquer outra coisa devolve "sem decisão" e o
 * assistente pergunta à pessoa. FAIL-OPEN total: nunca lança e nunca trava a
 * voz — sem chave, desligado, limite, timeout ou erro viram "sem decisão".
 *
 * O que sai para o provedor é o que a pessoa disse e os títulos dos candidatos
 * (texto digitado por ela), redigidos e limitados a 2 KB. Os candidatos viajam
 * por posição (`m1`…`m5`): nenhum id real, caminho ou conversa. O diário de
 * decisões grava só ids de pergunta, probabilidades e a decisão — nunca texto.
 */
import {
  MISSION_PICK_LIMITS,
  type MissionPickKind,
  type MissionPickRequest,
  type MissionPickResult,
  type MissionPickUndecidedReason,
} from '../../shared/mission-pick';
import { redactSecrets, redactState } from '../decision-models/decision-redaction';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import { decisionResultUsage } from '../decision-models/decision-usage';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { judge, type JevAnswer, type JevQuestion } from './jev-client';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from './jev-decision-log';
import { consumeJevRateSlot } from './jev-rate-limit';

/** Desempate entre títulos parecidos: confiança mínima da resposta para a escolha valer. */
export const MISSION_PICK_MIN_CONFIDENCE = 0.7;
/** Desempate: distância mínima entre a escolhida e a 2ª mais provável (o `none` conta). */
export const MISSION_PICK_MIN_MARGIN = 0.15;
/**
 * Nada casou com o que foi dito: o texto falado pode ser ruído do STT, então o
 * piso é mais rígido que o do desempate.
 */
export const MISSION_PICK_NO_MATCH_MIN_CONFIDENCE = 0.9;
export const MISSION_PICK_NO_MATCH_MIN_MARGIN = 0.3;

interface PickFloor {
  readonly minConfidence: number;
  readonly minMargin: number;
}

const PICK_FLOORS: Readonly<Record<MissionPickKind, PickFloor>> = {
  ambiguous: { minConfidence: MISSION_PICK_MIN_CONFIDENCE, minMargin: MISSION_PICK_MIN_MARGIN },
  noMatch: {
    minConfidence: MISSION_PICK_NO_MATCH_MIN_CONFIDENCE,
    minMargin: MISSION_PICK_NO_MATCH_MIN_MARGIN,
  },
};
/** Espera por tentativa; a voz não pode ficar muda além disto. */
export const MISSION_PICK_TIMEOUT_MS = 3_000;
/** Teto total (inclui o retry de erro de rede do cliente). */
const MISSION_PICK_TOTAL_TIMEOUT_MS = 3_500;
/** Teto do `state` enviado, em bytes UTF-8 do JSON. */
export const MISSION_PICK_STATE_MAX_BYTES = 2_048;

const RATE_LIMIT_KEY = 'mission-pick';
/** Do mais largo ao mais curto: o primeiro que cabe nos 2 KB vence. */
const TITLE_CAPS = [MISSION_PICK_LIMITS.titleMax, 70, 50, 30, 20] as const;
const SAID_CAP = MISSION_PICK_LIMITS.spokenMax;
const PICK_QUESTION_ID = 'pick';
const NONE_ID = 'none';
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
/** Probabilidades chegam arredondadas pelo provedor; evita que 0,7 − 0,55 caia em 0,1499…. */
const PROBABILITY_PRECISION = 1e6;

export interface MissionPickState {
  readonly said: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly lastActivity?: string;
  }[];
}

/** Redige primeiro e só então corta (cortar no meio de um segredo o deixaria passar). */
function cleanText(text: string, maxCodePoints: number): string {
  const redacted = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return Array.from(redacted).slice(0, maxCodePoints).join('');
}

function relativeAge(updatedAt: number, now: number): string {
  const minutes = Math.floor((now - updatedAt) / MS_PER_MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} h ago`;
  return `${Math.floor(hours / HOURS_PER_DAY)} d ago`;
}

function stateWithCap(
  request: MissionPickRequest,
  now: number,
  titleCap: number,
): MissionPickState {
  return {
    said: cleanText(request.spoken, SAID_CAP),
    candidates: request.candidates.map((candidate, index) => ({
      id: `m${index + 1}`,
      title: cleanText(candidate.title, titleCap),
      status: candidate.state,
      ...(candidate.updatedAt === undefined
        ? {}
        : { lastActivity: relativeAge(candidate.updatedAt, now) }),
    })),
  };
}

/**
 * O estado enviado ao provedor. Devolve `null` se nem com os títulos mais
 * curtos ele cabe em `maxBytes` — melhor não consultar do que mandar demais.
 */
export function buildMissionPickState(
  request: MissionPickRequest,
  now: number,
  maxBytes: number = MISSION_PICK_STATE_MAX_BYTES,
): MissionPickState | null {
  for (const cap of TITLE_CAPS) {
    // redactState de novo: o transporte também redige, mas o teto de bytes
    // precisa ser medido sobre o que realmente sai.
    const state = redactState(stateWithCap(request, now, cap)) as MissionPickState;
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') <= maxBytes) return state;
  }
  return null;
}

const TIE_BREAK_INSTRUCTIONS =
  'The person asked a voice assistant to open one of their saved missions. ' +
  '`said` is what they said (speech recognition can garble names). ' +
  'Pick the single mission in `candidates` they most likely mean, judging by the title. ' +
  '`status` and `lastActivity` matter only if `said` refers to them (for example ' +
  '"the running one" or "the latest"); never use them to break a tie between titles ' +
  'that fit equally well. Choose none when no title clearly fits or when two or more fit equally well.';

const NO_MATCH_INSTRUCTIONS =
  'The person asked a voice assistant to open one of their saved missions, but `said` does not ' +
  'literally match any title: speech recognition may have garbled the name (wrong letters, ' +
  'split or merged words, numbers spelled out). Pick the single mission in `candidates` that ' +
  '`said` is most plausibly a garbled version of, by sound or by meaning. Do not guess: ' +
  'choose none when `said` is unrelated to every title, or when two or more fit about equally well.';

const NONE_CRITERION: Readonly<Record<MissionPickKind, string>> = {
  ambiguous:
    'No candidate clearly matches what the person said, or two or more of them fit equally well.',
  noMatch:
    'No candidate is clearly what the person meant: `said` is unrelated to every title, or two or more fit about equally well.',
};

/**
 * Uma opção por candidato mais `none`. O título é texto digitado pela pessoa e
 * por isso NÃO é colado na pergunta: o critério aponta o caminho no `state`.
 */
export function buildMissionPickQuestion(
  candidateCount: number,
  kind: MissionPickKind = 'ambiguous',
): JevQuestion {
  const criteria: Record<string, string | null> = {};
  for (let index = 0; index < candidateCount; index += 1) {
    criteria[`m${index + 1}`] =
      `The mission whose title is \`candidates[${index}].title\`.`;
  }
  criteria[NONE_ID] = NONE_CRITERION[kind];
  return {
    type: 'choice',
    instructions: kind === 'noMatch' ? NO_MATCH_INSTRUCTIONS : TIE_BREAK_INSTRUCTIONS,
    criteria,
  };
}

function undecided(reason: MissionPickUndecidedReason): MissionPickResult {
  return { decision: 'undecided', reason };
}

function candidateIndex(choice: string, candidateCount: number): number | null {
  const match = /^m([1-9]\d*)$/.exec(choice);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index < candidateCount ? index : null;
}

/** A regra de aceitação, pura: o que a resposta do modelo autoriza a fazer. */
export function evaluateMissionPickAnswer(
  answer: JevAnswer | undefined,
  candidateCount: number,
  kind: MissionPickKind = 'ambiguous',
): MissionPickResult {
  const floor = PICK_FLOORS[kind];
  if (answer?.type !== 'choice') return undecided('invalid-answer');
  if (answer.choice === NONE_ID) return undecided('none');
  const index = candidateIndex(answer.choice, candidateCount);
  const own = answer.probabilities[answer.choice];
  if (index === null || own === undefined) return undecided('invalid-answer');
  const runnerUp = Object.entries(answer.probabilities)
    .filter(([id]) => id !== answer.choice)
    .reduce((best, [, probability]) => Math.max(best, probability), 0);
  // A escolha tem de ser a opção mais provável da própria distribuição.
  if (runnerUp > own) return undecided('invalid-answer');
  if (answer.confidence < floor.minConfidence) return undecided('low-confidence');
  const margin = Math.round((own - runnerUp) * PROBABILITY_PRECISION) / PROBABILITY_PRECISION;
  if (margin < floor.minMargin) return undecided('narrow-margin');
  return { decision: 'picked', index, confidence: answer.confidence };
}

export interface MissionPickDeps {
  judge?: typeof judge;
  surfaceEnabled?: () => boolean;
  hasKey?: () => boolean;
  consumeRate?: () => boolean;
  record?: typeof recordJevDecision;
  now?: () => number;
}

/** `pick:mN` / `ask:motivo`; o caminho "nada casou" leva o prefixo `noMatch:`. Nunca texto. */
function journalDecision(result: MissionPickResult, kind: MissionPickKind): string {
  const outcome =
    result.decision === 'picked' ? `pick:m${result.index + 1}` : `ask:${result.reason}`;
  return kind === 'noMatch' ? `noMatch:${outcome}` : outcome;
}

/**
 * UMA consulta ao modelo de decisão. Nunca lança: o chamador (IPC → voz) só vê
 * "escolhi o candidato N" ou "sem decisão" com um motivo categórico.
 */
export async function pickMissionWithJev(
  request: MissionPickRequest,
  deps: MissionPickDeps = {},
): Promise<MissionPickResult> {
  try {
    if (!(deps.surfaceEnabled ?? (() => isJevSurfaceEnabled('missionPick')))()) {
      return undecided('disabled');
    }
    if (!(deps.hasKey ?? (() => hasDecisionCredential('missionPick')))()) {
      return undecided('unavailable');
    }
    if (!(deps.consumeRate ?? (() => consumeJevRateSlot(RATE_LIMIT_KEY)))()) {
      return undecided('rate-limited');
    }
    const kind: MissionPickKind = request.kind ?? 'ambiguous';
    const state = buildMissionPickState(request, (deps.now ?? Date.now)());
    if (!state) return undecided('invalid-request');

    const outcome = await (deps.judge ?? judge)({
      state,
      questions: {
        [PICK_QUESTION_ID]: buildMissionPickQuestion(request.candidates.length, kind),
      },
      timeoutMs: MISSION_PICK_TIMEOUT_MS,
      // Teto total: sem isto o retry do cliente dobraria a espera da voz.
      signal: AbortSignal.timeout(MISSION_PICK_TOTAL_TIMEOUT_MS),
      // F-1626: m1 é a 1ª opção; escolha limítrofe nela é reconferida invertida.
      orderCheck: { minConfidence: MISSION_PICK_MIN_CONFIDENCE },
      surface: 'missionPick',
      retryOnTimeout: false,
    });
    if (!outcome) return undecided('unavailable');

    const result = evaluateMissionPickAnswer(
      outcome.answers[PICK_QUESTION_ID],
      request.candidates.length,
      kind,
    );
    try {
      (deps.record ?? recordJevDecision)({
        surface: 'missionPick',
        model: outcome.model,
        questions: [PICK_QUESTION_ID],
        probabilities: jevAnswerProbabilities(outcome.answers),
        confidence: jevAnswerConfidences(outcome.answers),
        decision: journalDecision(result, kind),
        ...decisionResultUsage(outcome),
      });
    } catch {
      // O diário nunca derruba a decisão (e nada do erro sai daqui).
    }
    return result;
  } catch {
    return undecided('error');
  }
}
