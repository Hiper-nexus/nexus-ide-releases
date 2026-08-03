/**
 * Clarify contract (inspired by peer ADE's nexus_clarify): a structured
 * question with suggestion chips. `buildClarify` is what the `nexus_clarify`
 * MCP tool persists. `resolveClarifyAnswer` is the canonical routing spec for
 * the reply — it maps a raw answer (chip id, exact label, or 1-based number)
 * to a chip, or freeform when allowed. Artifact parsers below are shared by
 * main and renderer so neither side guesses at an untyped TUI payload.
 */

const MAX_OPTIONS = 6;
const MAX_QUESTION_CHARS = 2_000;
const MAX_OPTION_CHARS = 240;
const MAX_ANSWER_CHARS = 4_000;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

export interface ClarifyChip {
  id: string;
  label: string;
}

export interface Clarify {
  question: string;
  chips: ClarifyChip[];
  allowFreeform: boolean;
}

export interface ClarifyQuestionArtifact {
  readonly kind: 'nexus-clarify-question';
  readonly schemaVersion: 1;
  readonly clarify: Clarify;
}

export interface ClarifyAnswerArtifact {
  readonly kind: 'nexus-clarify-answer';
  readonly schemaVersion: 1;
  readonly questionId: string;
  readonly answer: Exclude<ClarifyAnswer, { kind: 'unmatched' }>;
}

export interface DurableClarifyQuestion extends Clarify {
  readonly questionId: string;
  readonly missionId: string;
}

export interface ClarifyAnswerInput {
  readonly missionId: string;
  readonly questionId: string;
  /** Chip id/label/index or bounded free text when the question permits it. */
  readonly answer: string;
}

export interface ClarifyAnswerResult {
  readonly ok: true;
  readonly missionId: string;
  readonly questionId: string;
  readonly handoffId: string;
  readonly answer: Exclude<ClarifyAnswer, { kind: 'unmatched' }>;
  readonly deliveryState: 'queued' | 'submitted' | 'acknowledged' | 'consumed';
  /** True only after the orchestrator TUI produced the idle→busy acceptance edge. */
  readonly accepted: boolean;
  /** Reader-facing next action in PT-BR. */
  readonly cta: string;
}

export interface BuildClarifyInput {
  question: string;
  options: string[];
  allowFreeform?: boolean;
}

export function buildClarify(input: BuildClarifyInput): Clarify {
  const question = input.question.trim();
  if (!question) throw new Error('a pergunta do clarify não pode ficar vazia');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(
      `a pergunta do clarify aceita no máximo ${MAX_QUESTION_CHARS} caracteres`,
    );
  }
  if (FORBIDDEN_CONTROLS.test(question)) {
    throw new Error('a pergunta do clarify contém caracteres de controle');
  }
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) {
    throw new Error('o clarify precisa de ao menos 2 opções');
  }
  if (options.length > MAX_OPTIONS) {
    throw new Error(`o clarify aceita no máximo ${MAX_OPTIONS} opções`);
  }
  if (
    options.some(
      (option) =>
        option.length > MAX_OPTION_CHARS || FORBIDDEN_CONTROLS.test(option),
    )
  ) {
    throw new Error(
      `cada opção do clarify deve ter até ${MAX_OPTION_CHARS} caracteres e nenhum controle`,
    );
  }
  if (
    new Set(options.map((option) => option.toLowerCase())).size !==
    options.length
  ) {
    throw new Error('as opções do clarify não podem ser duplicadas');
  }
  return {
    question,
    chips: options.map((label, i) => ({ id: `opt-${i + 1}`, label })),
    allowFreeform: input.allowFreeform ?? true,
  };
}

export type ClarifyAnswer =
  | { kind: 'chip'; chipId: string; value: string }
  | { kind: 'freeform'; value: string }
  | { kind: 'unmatched' };

/**
 * Route a raw answer to a chip (by id, exact label, or 1-based index) or,
 * failing that, to freeform when allowed. Never guesses a chip from a fuzzy
 * match — an unrecognized answer with freeform off is `unmatched`.
 */
export function resolveClarifyAnswer(clarify: Clarify, raw: string): ClarifyAnswer {
  const answer = raw.trim();
  if (!answer) return { kind: 'unmatched' };
  if (answer.length > MAX_ANSWER_CHARS || FORBIDDEN_CONTROLS.test(answer)) {
    return { kind: 'unmatched' };
  }

  const byId = clarify.chips.find((c) => c.id === answer);
  if (byId) return { kind: 'chip', chipId: byId.id, value: byId.label };

  const lower = answer.toLowerCase();
  const byLabel = clarify.chips.find((c) => c.label.toLowerCase() === lower);
  if (byLabel) return { kind: 'chip', chipId: byLabel.id, value: byLabel.label };

  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    const chip = clarify.chips[index];
    if (chip) return { kind: 'chip', chipId: chip.id, value: chip.label };
  }

  if (clarify.allowFreeform) return { kind: 'freeform', value: answer };
  return { kind: 'unmatched' };
}

/**
 * Parse a question envelope from durable handoff artifacts. Rebuilding the
 * clarify from labels also verifies deterministic opt-N ids and every bound.
 */
export function parseClarifyQuestionArtifact(
  raw: unknown,
): ClarifyQuestionArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as {
    kind?: unknown;
    schemaVersion?: unknown;
    clarify?: unknown;
  };
  if (
    candidate.kind !== 'nexus-clarify-question' ||
    candidate.schemaVersion !== 1 ||
    !candidate.clarify ||
    typeof candidate.clarify !== 'object'
  ) {
    return null;
  }
  const clarify = candidate.clarify as {
    question?: unknown;
    chips?: unknown;
    allowFreeform?: unknown;
  };
  if (
    typeof clarify.question !== 'string' ||
    !Array.isArray(clarify.chips) ||
    typeof clarify.allowFreeform !== 'boolean'
  ) {
    return null;
  }
  const labels: string[] = [];
  for (let index = 0; index < clarify.chips.length; index += 1) {
    const chip = clarify.chips[index];
    if (
      !chip ||
      typeof chip !== 'object' ||
      (chip as { id?: unknown }).id !== `opt-${index + 1}` ||
      typeof (chip as { label?: unknown }).label !== 'string'
    ) {
      return null;
    }
    labels.push((chip as { label: string }).label);
  }
  try {
    return {
      kind: 'nexus-clarify-question',
      schemaVersion: 1,
      clarify: buildClarify({
        question: clarify.question,
        options: labels,
        allowFreeform: clarify.allowFreeform,
      }),
    };
  } catch {
    return null;
  }
}

export function parseClarifyAnswerArtifact(
  raw: unknown,
): ClarifyAnswerArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as {
    kind?: unknown;
    schemaVersion?: unknown;
    questionId?: unknown;
    answer?: unknown;
  };
  if (
    candidate.kind !== 'nexus-clarify-answer' ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.questionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(candidate.questionId) ||
    !candidate.answer ||
    typeof candidate.answer !== 'object'
  ) {
    return null;
  }
  const answer = candidate.answer as {
    kind?: unknown;
    chipId?: unknown;
    value?: unknown;
  };
  if (
    typeof answer.value !== 'string' ||
    answer.value.length === 0 ||
    answer.value.length > MAX_ANSWER_CHARS ||
    FORBIDDEN_CONTROLS.test(answer.value)
  ) {
    return null;
  }
  if (
    answer.kind === 'chip' &&
    typeof answer.chipId === 'string' &&
    /^opt-[1-6]$/.test(answer.chipId)
  ) {
    return {
      kind: 'nexus-clarify-answer',
      schemaVersion: 1,
      questionId: candidate.questionId,
      answer: {
        kind: 'chip',
        chipId: answer.chipId,
        value: answer.value,
      },
    };
  }
  if (answer.kind === 'freeform') {
    return {
      kind: 'nexus-clarify-answer',
      schemaVersion: 1,
      questionId: candidate.questionId,
      answer: { kind: 'freeform', value: answer.value },
    };
  }
  return null;
}
