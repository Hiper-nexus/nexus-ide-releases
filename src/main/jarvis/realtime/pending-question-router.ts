/**
 * Deterministic pending-question answer routing (peer ADE C-085 r3 / C-092.11).
 *
 * When a working pane narrates a question, the user's next FINAL non-UI
 * utterance is — by construction — the answer to that dialog. It is routed
 * straight back to the pane (model bypassed) instead of being re-interpreted as
 * a new command. This module is the PURE decision core: which pane has a live
 * pending question, whether an utterance looks like an answer to it, TTL expiry,
 * and same-utterance dedup. The async pane_read revalidation + pane_write is the
 * caller's (controller's) job.
 *
 * Constants and regex are copied literally from the sidecar reference; the
 * decision logic is re-expressed idiomatically. Injected clock — testable.
 */

// ── Timing constants (JarvisService.js) ──────────────────────────────────────
/** Poll cadence for a delegated pane's pending question (JarvisService.js:709). */
export const QUESTION_POLL_MS = 8_000;
/** A narrated question older than this stops hijacking the next utterance (:715). */
export const NARRATED_QUESTION_TTL_MS = 3 * 60 * 1000;
/** Same utterance routed twice within this window becomes an ack, no 2nd write (:733). */
export const ROUTED_ANSWER_DEDUP_MS = 15_000;
/** Short dedicated poll for an awaited answer (:763). */
export const ANSWER_POLL_MS = 1_500;
/** Max wall-clock for the awaited-answer poll (:764). */
export const ANSWER_POLL_MAX_MS = 120_000;

// ── Utterance classification (JarvisService.js:1300, 2103) ───────────────────
/** "situação" / "como tá" / status questions — anchored to the active mission. */
const STATUS_QUESTION_RE =
  /situa[çc][ãa]o|como (?:t[áa]|anda|est[áa]|vai)|o que (?:t[áa]|est[áa]) (?:acontecendo|rolando)|qual (?:o |a )?status/i;

export function isStatusQuestion(text: string): boolean {
  return STATUS_QUESTION_RE.test(text);
}

/**
 * A UI/navigation command (open/close/focus a workspace/pane/screen, list, count,
 * farewell) — NOT an answer to a pending work question. Re-expressed for nexus's
 * UI vocabulary (workspace/squad/pane/terminal/browser/grid/board/settings).
 */
const UI_UTTERANCE_RE =
  /\b(abre|abra|abrir|fecha|feche|fechar|mostra|mostre|volta|voltar|navega|foca|focar|entra|sai|troca|restaura|cancela|desliga|encerra)\b|\b(tela|workspace|squad|pane|terminal|browser|navegador|cat[áa]logo|settings|configura|grid|grade|board|quadro)\b|\bmiss[õo]es\b|\blista\b|\bquantos?\b|tchau|at[ée] mais|[ée] s[óo] isso|valeu/i;

export function isUiUtterance(text: string): boolean {
  return UI_UTTERANCE_RE.test(text) || isStatusQuestion(text);
}

/**
 * A fresh wh-question the user is ASKING (time/date/count/where/who/why), not an
 * answer to a pending pane question. Anchored to a LEADING interrogative so plain
 * declarative answers ("a opção dois", "usa o Postgres") never match. Bounds the
 * short-utterance blanket below: because the narrated hash is only the handoff
 * SUMMARY (a weak proxy for the literal question), an unrelated quick question
 * like "que horas são?" must not be hijacked into the pane while a handoff blocks.
 */
const NEW_QUESTION_RE =
  /^\s*(?:e\s+)?(?:qual|quais|quando|onde|quem|quantos?|quantas?|cad[êe]|por\s*que|pra\s+que|para\s+que|que\s+horas?|que\s+dia|que\s+data)(?![\p{L}])/iu;

export function isLikelyNewQuestion(text: string): boolean {
  return NEW_QUESTION_RE.test(text.trim());
}

/**
 * Plausible-answer heuristic (JarvisService.js:2204): a short utterance (typical
 * spoken answer), or one referencing an option/number, or sharing a significant
 * word with the narrated question. A long imperative with no relation = new work.
 * A leading wh-question is a NEW query and is rejected even when short (bounds the
 * ≤80-char blanket flagged in the release re-review).
 */
export function looksLikePendingAnswer(utterance: string, question: string): boolean {
  const clean = utterance.trim();
  if (isLikelyNewQuestion(clean)) return false;
  if (clean.length <= 80) return true;
  if (!question) return false;
  if (/\bop[çc][ãa]o\b|\bn[úu]mero\b/i.test(clean)) return true;
  const qWords = new Set(question.toLowerCase().match(/[\p{L}]{5,}/gu) ?? []);
  const uWords = clean.toLowerCase().match(/[\p{L}]{5,}/gu) ?? [];
  return uWords.some((w) => qWords.has(w));
}

export type RouteDecision =
  | { route: false; reason: string }
  | { route: true; paneId: string; text: string };

export interface PendingQuestionRouterDeps {
  now(): number;
}

export class PendingQuestionRouter {
  /** Per-pane narrated pending question (insertion order = recency). */
  private narratedQuestion = new Map<string, { hash: string; at: number }>();
  private routedAnswer: { paneId: string; text: string; at: number } | null = null;

  constructor(private readonly deps: PendingQuestionRouterDeps) {}

  /** A pane narrated a pending question (menu/AskUserQuestion) — remember it. */
  noteNarratedQuestion(paneId: string, questionHash: string): void {
    if (!paneId || !questionHash.trim()) return;
    // Re-insert to keep recency order (Map preserves insertion order).
    this.narratedQuestion.delete(paneId);
    this.narratedQuestion.set(paneId, { hash: questionHash, at: this.deps.now() });
  }

  /** The narrated question hash currently pending on a pane (or null). */
  questionFor(paneId: string): string | null {
    return this.narratedQuestion.get(paneId)?.hash ?? null;
  }

  clearQuestion(paneId: string): void {
    this.narratedQuestion.delete(paneId);
  }

  /**
   * Defesa C3: pergunta narrada velha não autoriza escrita direta. Igual ao
   * TTL de `decide`, mas sem exigir uma nova utterance — usado pelo guard de
   * `send_to_pane`/`ask_pane` que só quer saber "esse pane tem pergunta viva
   * agora?". Uma entrada expirada é removida (não fica pendurada até o
   * próximo `decide`).
   */
  hasLiveQuestion(paneId: string): boolean {
    const entry = this.narratedQuestion.get(paneId);
    if (!entry) return false;
    if (this.deps.now() - entry.at > NARRATED_QUESTION_TTL_MS) {
      this.narratedQuestion.delete(paneId);
      return false;
    }
    return true;
  }

  /**
   * The pane with a live pending question — prefers the focused pane, else the
   * most recent one (Map insertion order). null = no pending dialog.
   */
  pendingQuestionPaneId(focusedPaneId?: string): string | null {
    let candidate: string | null = null;
    for (const paneId of this.narratedQuestion.keys()) {
      candidate = paneId;
      if (focusedPaneId && paneId === focusedPaneId) return paneId;
    }
    return candidate;
  }

  /**
   * Decide whether the next FINAL user utterance should be routed to a pending
   * pane. A stale narrated question (past the TTL) is cleared and not routed.
   */
  decide(utterance: string, focusedPaneId?: string): RouteDecision {
    const text = utterance.trim();
    if (!text) return { route: false, reason: 'empty' };
    const paneId = this.pendingQuestionPaneId(focusedPaneId);
    if (!paneId) return { route: false, reason: 'no-pending-question' };
    if (isUiUtterance(text)) return { route: false, reason: 'ui-utterance' };
    const entry = this.narratedQuestion.get(paneId);
    if (!entry) return { route: false, reason: 'no-pending-question' };
    if (this.deps.now() - entry.at > NARRATED_QUESTION_TTL_MS) {
      this.narratedQuestion.delete(paneId);
      return { route: false, reason: 'question-stale' };
    }
    if (!looksLikePendingAnswer(text, entry.hash)) {
      return { route: false, reason: 'not-an-answer' };
    }
    return { route: true, paneId, text };
  }

  /** Record that an answer was routed to a pane (dedup baseline). */
  markRouted(paneId: string, text: string): void {
    this.routedAnswer = { paneId, text, at: this.deps.now() };
  }

  /**
   * Was this same utterance just routed to the pane (dedup window)? The Live
   * model may still call a tool with the same content right after the technical
   * route — this turns that into an ack, not a 2nd write (JarvisService.js:2222).
   */
  wasAnswerJustRouted(text: string, paneId?: string): boolean {
    const routed = this.routedAnswer;
    if (!routed) return false;
    if (this.deps.now() - routed.at > ROUTED_ANSWER_DEDUP_MS) return false;
    if (paneId && paneId !== routed.paneId) return false;
    const norm = (s: string): string =>
      s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const a = norm(text);
    const b = norm(routed.text);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    if (shorter.length < 15) return false;
    return (
      longer.startsWith(`${shorter} `) ||
      longer.endsWith(` ${shorter}`) ||
      longer.includes(` ${shorter} `)
    );
  }
}
