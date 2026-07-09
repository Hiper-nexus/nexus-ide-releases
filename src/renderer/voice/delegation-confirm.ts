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
]);
/** Apoio tolerado dentro de uma confirmação curta ("manda ver", "isso aí"). */
const AFFIRMATIVE_FILLER = new Set([
  'com',
  'ver',
  'ai',
  'la',
  'e',
  'jarvis',
  'pro',
  'pra',
  'para',
  'o',
  'a',
  'squad',
  'missao',
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
