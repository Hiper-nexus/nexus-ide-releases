/**
 * Clarify contract (inspired by Overclock's overclock_clarify): a structured
 * question with suggestion chips and DETERMINISTIC answer routing, so a
 * clarification round doesn't dead-end into free-text parsing. Pure logic —
 * the MCP tool builds the request; the answer is resolved back to a canonical
 * option here regardless of whether the user clicked a chip, typed its text,
 * or typed its number.
 */

const MAX_OPTIONS = 6;

export interface ClarifyChip {
  id: string;
  label: string;
}

export interface Clarify {
  question: string;
  chips: ClarifyChip[];
  allowFreeform: boolean;
}

export interface BuildClarifyInput {
  question: string;
  options: string[];
  allowFreeform?: boolean;
}

export function buildClarify(input: BuildClarifyInput): Clarify {
  const question = input.question.trim();
  if (!question) throw new Error('a pergunta do clarify não pode ficar vazia');
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) {
    throw new Error('o clarify precisa de ao menos 2 opções');
  }
  if (options.length > MAX_OPTIONS) {
    throw new Error(`o clarify aceita no máximo ${MAX_OPTIONS} opções`);
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
