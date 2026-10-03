import { decisionResultUsage } from '../decision-models/decision-usage';
/**
 * Conselho de delegação via TypeSafe Jev (superfície `delegation`, C2 25/09).
 * A cada mensagem que o operador manda a um pane dele, o hook UserPromptSubmit
 * pergunta: isto se divide? em quantas partes? quantas escrevem? Com 2+ partes
 * e confiança ≥ 0,6 o pane recebe um lembrete para delegar; sem partes, uma
 * leitura pesada (≥ 0,7) vai para um helper readOnly (F-784). FAIL-OPEN:
 * null = nenhum lembrete, o pane segue como hoje.
 */
import {
  capText,
  judge,
  type JevQuestion,
} from './jev-client';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from './jev-decision-log';

export const DELEGATE_MIN_PROMPT_CHARS = 40;
export const DELEGATE_MIN_CONFIDENCE = 0.6;
/**
 * F-784: leitura pesada (varrer código, logs ou fontes) vai para UM helper
 * readOnly mesmo sem partes independentes — a doutrina do operador manda
 * delegar o que é "divisível, pesado ou paralelizável", e a pergunta de
 * divisão só enxergava o primeiro. Limiar acima do da divisão: pergunta
 * respondida com o que está à mão fica no pane.
 */
export const HEAVY_READ_MIN_CONFIDENCE = 0.7;
/** Confiança a partir da qual o Nexus promove o pane a orquestrador (Autopilot). */
export const AUTO_ORCHESTRATE_MIN_CONFIDENCE = 0.7;
export const DELEGATE_TIMEOUT_MS = 2_500;
const DELEGATE_MAX_CHARS = 3_000;

const DELEGATION_QUESTIONS: Record<string, JevQuestion> = {
  divisible: {
    type: 'noul',
    instructions:
      'Does this request to a coding agent ask for work that splits into ' +
      'independent parts that separate agents could do in parallel?',
    criteria: {
      // F-784: em 03/10 a mensagem que listava quatro defeitos distintos num
      // parágrafo só, como continuação, saiu "solo" (0,29).
      true: 'several independent pieces of work (research, implementation, tests, review…), a message that lists several distinct problems or requests (even in one paragraph or as a follow-up), or the same feature or fix to be built in separate apps or surfaces (for example the native app and the web or PWA)',
      false: 'one cohesive task, a small change, a single bug, a question or conversation, or a short follow-up or confirmation of work already under way',
    },
  },
  heavyRead: {
    type: 'noul',
    instructions:
      'Does this request ask for a broad read-only investigation — reading ' +
      'many files, logs, documents or web sources, an audit or an analysis ' +
      'across the system — that a helper agent could carry out while this ' +
      'agent stays free?',
    criteria: {
      true: 'a broad investigation, audit, research or analysis that needs reading many files, logs or sources',
      false: 'a question answerable from what is already at hand, a small lookup, a change to make, or conversation',
    },
  },
  parts: {
    type: 'choice',
    instructions: 'How many independent parts does this work split into?',
    criteria: { '1': null, '2': null, '3': null, '4': null, '5+': null },
  },
  writers: {
    type: 'choice',
    instructions: 'How many of those parts change code or files (the rest only read)?',
    criteria: { '0': null, '1': null, '2+': null },
  },
  // Mesma chamada, uma pergunta a mais: pedido de escrever código recebe o
  // lembrete da skill ponytail no hook (hook-delegate-endpoint).
  writesCode: {
    type: 'noul',
    instructions:
      'Does this message ask the coding agent to write, change, refactor or fix code?',
    criteria: {
      true: 'implement, change, refactor or fix code or config in the repository',
      false: 'a question, an explanation, research, review, planning or conversation',
    },
  },
};

export interface DelegationAdvice {
  readonly parts: number;
  readonly writers: number;
  readonly confidence: number;
  readonly model: string;
  /** F-784: sem partes independentes, mas leitura pesada — um helper readOnly. */
  readonly heavyRead?: true;
}

export interface PromptAdvice {
  /** Lembrete de delegação (2+ partes com confiança) ou null. */
  readonly delegation: DelegationAdvice | null;
  /** Probabilidade de a mensagem pedir para escrever ou mudar código. */
  readonly writesCode: number;
}

export interface AdviseDelegationDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  sessionId?: string;
}

function countOf(choice: string | undefined): number {
  const parsed = Number.parseInt(choice ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function adviseDelegation(
  message: string,
  deps: AdviseDelegationDeps = {},
): Promise<DelegationAdvice | null> {
  return (await advisePrompt(message, deps))?.delegation ?? null;
}

/** Uma chamada ao Jev por mensagem: delegação e intenção de escrever código. */
export async function advisePrompt(
  message: string,
  deps: AdviseDelegationDeps = {},
): Promise<PromptAdvice | null> {
  if (message.trim().length < DELEGATE_MIN_PROMPT_CHARS) return null;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('delegation'));
  const hasKey = deps.hasKey ?? (() => hasDecisionCredential('delegation'));
  if (!enabled() || !hasKey()) return null;

  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: { message: capText(message, DELEGATE_MAX_CHARS) },
    questions: DELEGATION_QUESTIONS,
    timeoutMs: DELEGATE_TIMEOUT_MS,
    // Teto total: sem isto o retry do judge dobraria a espera do hook.
    signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    surface: 'delegation',
    sessionId: deps.sessionId,
  });
  if (!result) return null;

  const divisible = result.answers.divisible;
  const partsAnswer = result.answers.parts;
  const writersAnswer = result.answers.writers;
  if (divisible?.type !== 'noul' || partsAnswer?.type !== 'choice') return null;
  const parts = countOf(partsAnswer.choice);
  const writers = Math.min(
    parts,
    writersAnswer?.type === 'choice' ? countOf(writersAnswer.choice) : 0,
  );
  const split = divisible.noul >= DELEGATE_MIN_CONFIDENCE && parts >= 2;
  const heavyReadAnswer = result.answers.heavyRead;
  const heavyRead = heavyReadAnswer?.type === 'noul' ? heavyReadAnswer.noul : 0;
  // F-784: sem partes independentes, leitura pesada ainda sai do pane — vai
  // para um helper readOnly e o pane segue livre.
  const readAlone = !split && heavyRead >= HEAVY_READ_MIN_CONFIDENCE;

  recordJevDecision({
    surface: 'delegation',
    sessionId: deps.sessionId,
    model: result.model,
    questions: Object.keys(DELEGATION_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: split
      ? `delegate:${parts}p/${writers}w`
      : readAlone
        ? 'delegate:heavy-read'
        : 'solo',
    ...decisionResultUsage(result),
  });
  const writesCodeAnswer = result.answers.writesCode;
  return {
    delegation: split
      ? { parts, writers, confidence: divisible.noul, model: result.model }
      : readAlone
        ? { parts: 1, writers: 0, confidence: heavyRead, model: result.model, heavyRead: true }
        : null,
    writesCode: writesCodeAnswer?.type === 'noul' ? writesCodeAnswer.noul : 0,
  };
}
