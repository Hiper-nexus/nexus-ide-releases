/**
 * Portão de confirmação POR VOZ da delegação de código (C3): send_to_pane
 * despachava um prompt autorado por LLM sem confirmação nenhuma, com fallback
 * silencioso até o pane focado (um brief de engenharia digitado num bash puro,
 * ou disparado por fala mal-transcrita/injetada). Decisão do dono: delegação
 * confirma por voz ("Confirmo?"); modal nativo fica só para destrutivo.
 *
 * Estado mínimo de UMA pendência + classificação PURA da resposta. A resposta
 * que não for sim/não DESCARTA a missão (nunca despachar sem um "sim").
 */

export interface PendingDelegation {
  targetPaneId: string;
  text: string;
  createdAt: number;
}

export const DELEGATION_CONFIRM_TTL_MS = 15_000;
export const CONFIRM_SUMMARY_MAX_CHARS = 80;

let pending: PendingDelegation | null = null;

export function setPendingDelegation(d: PendingDelegation): void {
  pending = d;
}

export function clearPendingDelegation(): void {
  pending = null;
}

/** Pendência atual, expirando pelo TTL (uma confirmação velha não vale). */
export function peekPendingDelegation(now: number): PendingDelegation | null {
  if (pending && now - pending.createdAt > DELEGATION_CONFIRM_TTL_MS) {
    pending = null;
  }
  return pending;
}

/**
 * C3 Fase 1 (re-ask): quando a JARVIS re-pergunta ("confirma?"), o relógio do
 * TTL reinicia — a pergunta acabou de ser re-posta em voz alta, então uma
 * resposta nos próximos 15s é fresca. NUNCA ressuscita pendência já expirada.
 */
export function refreshPendingDelegation(now: number): PendingDelegation | null {
  const alive = peekPendingDelegation(now);
  if (!alive) return null;
  pending = { ...alive, createdAt: now };
  return pending;
}

/**
 * Falado quando um re-wake stripa pra vazio com pendência viva. Mais de 6
 * palavras DE PROPÓSITO: o próprio eco nunca passa no matcher de afirmativa
 * isolada (pin em delegation-confirm.test.ts).
 */
export const PENDING_REASK_PROMPT =
  'Ainda tenho a missão pendente pro squad — confirma?';

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEGATIVE_RE =
  /\b(nao|cancela|cancelar|espera|pera|para|deixa|esquece|negativo)\b/;

/**
 * Follow-up 1: afirmativa só vale ISOLADA — a fala inteira precisa ser uma
 * confirmação curta ("sim", "pode mandar", "beleza, manda ver"). Um comando não
 * relacionado que apenas CONTÉM palavra afirmativa ("pode abrir o terminal")
 * não despacha: com o mic quente do Live por 15s, substring era gatilho de
 * despacho espúrio. Negativa continua ampla — cancelar é sempre barato.
 */
const AFFIRMATIVE_CORE = new Set([
  'sim',
  'confirmo',
  'confirma',
  'confirmado',
  'pode',
  'manda',
  'mandar',
  'bora',
  'beleza',
  'ok',
  'okay',
  'claro',
  'positivo',
  'demorou',
  'certeza',
  'isso',
  'continua',
  'continue',
  'continuar',
  'prossegue',
  'prossiga',
  'sequencia',
]);
/** Apoio tolerado dentro de uma confirmação curta ("manda ver", "isso aí"). */
// 'para'/'pare' está em NEGATIVE_RE, que tem precedência — mantê-lo aqui seria código morto e convite a enfraquecer a negativa.
const AFFIRMATIVE_FILLER = new Set([
  'com',
  'ver',
  'ai',
  'la',
  'e',
  'jarvis',
  'pro',
  'pra',
  'o',
  'a',
  'squad',
  'missao',
  'da',
  'dar',
  'na',
]);
const AFFIRMATIVE_MAX_WORDS = 6;

function isIsolatedAffirmative(normalized: string): boolean {
  const words = normalized.split(' ');
  if (words.length > AFFIRMATIVE_MAX_WORDS) return false;
  if (!words.some((w) => AFFIRMATIVE_CORE.has(w))) return false;
  return words.every((w) => AFFIRMATIVE_CORE.has(w) || AFFIRMATIVE_FILLER.has(w));
}

/** Negativa GANHA de afirmativa: "não pode" é não. */
export function classifyConfirmationReply(text: string): 'yes' | 'no' | 'other' {
  const n = norm(text);
  if (!n) return 'other';
  if (NEGATIVE_RE.test(n)) return 'no';
  if (isIsolatedAffirmative(n)) return 'yes';
  return 'other';
}

/** A pending confirmation owns an isolated yes/no before generic Live chat. */
export function isPendingDelegationConfirmation(text: string, now: number): boolean {
  return (
    peekPendingDelegation(now) !== null &&
    classifyConfirmationReply(text) !== 'other'
  );
}

/**
 * A native tool may replace an old pending confirmation with a new one. Only
 * discard the exact pending item that already existed when the turn started;
 * never erase the confirmation created by the tool that just completed.
 */
export function shouldDiscardPendingDelegationAfterUnrelatedTool(
  pendingAtTurnStart: PendingDelegation | null,
  current: PendingDelegation | null,
): boolean {
  if (!pendingAtTurnStart || !current) return false;
  return (
    current.createdAt === pendingAtTurnStart.createdAt &&
    current.targetPaneId === pendingAtTurnStart.targetPaneId &&
    current.text === pendingAtTurnStart.text
  );
}

export type DelegationReply =
  | { kind: 'dispatch'; delegation: PendingDelegation }
  | { kind: 'cancel' }
  | { kind: 'drop'; delegation: PendingDelegation }
  | { kind: 'none' };

/**
 * Resolve a fala seguinte contra a pendência. QUALQUER desfecho limpa o
 * estado: sim despacha, não cancela, outro assunto descarta ('drop' — o
 * chamador AVISA em vez de sumir mudo; follow-up 4a). 'none' = não havia
 * pendência viva.
 */
export function resolveDelegationReply(
  transcript: string,
  now: number,
): DelegationReply {
  const delegation = peekPendingDelegation(now);
  if (!delegation) return { kind: 'none' };
  clearPendingDelegation();
  const reply = classifyConfirmationReply(transcript);
  if (reply === 'yes') return { kind: 'dispatch', delegation };
  if (reply === 'no') return { kind: 'cancel' };
  return { kind: 'drop', delegation };
}

/** Frase falada em PT com a primeira linha da missão (truncada). */
export function delegationConfirmPrompt(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const summary =
    firstLine.length > CONFIRM_SUMMARY_MAX_CHARS
      ? `${firstLine.slice(0, CONFIRM_SUMMARY_MAX_CHARS)}…`
      : firstLine;
  return summary
    ? `Vou mandar pro squad: ${summary}. Confirmo?`
    : 'Vou mandar a missão pro squad. Confirmo?';
}
