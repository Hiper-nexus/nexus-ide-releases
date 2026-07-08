/**
 * ITEM 3: farewell-intent guard for the realtime `encerrar` tool.
 *
 * `encerrar` really ends the live session (drops the socket, HUD goes dormant),
 * so a model misfire — calling it when the user did NOT say goodbye — kills the
 * session mid-conversation and reads as "the HUD vanished". `encerrar` carries
 * no arguments, so the only intent signal is the user's own recent utterance.
 * We honor the end ONLY when that utterance clearly matches a goodbye; otherwise
 * the caller rejects the tool, answers normally, and logs encerrar.rejected.
 *
 * Pure + testable: normalize (lowercase, strip accents/punct) then match an
 * allowlist of PT-BR (+ a few EN) farewell phrases. Deliberately tight to avoid
 * a false honor — a missed goodbye just costs one extra "tchau", a false honor
 * kills the session.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-phrase / word-boundary farewell markers (already accent-stripped). */
const FAREWELL_PATTERNS: RegExp[] = [
  /\b(tchau|xau|adeus|falou|flw|fui)\b/,
  /\bate\s+(logo|mais|amanha|a\s+proxima|breve|ja)\b/,
  /\bvaleu\b/,
  /\b(e|era)\s+so\s+isso\b/,
  /\bso\s+isso\b/,
  /\bpor\s+enquanto\s+e\s+so\b/,
  /\bpode\s+(desligar|encerrar|fechar|parar)\b/,
  /\b(desliga|desligar|encerra|encerrar)\s*(a\s+sessao|tudo|ai|por\s+aqui)?\b/,
  /\bobrigad[oa]\s+por\s+tudo\b/,
  /\bboa\s+noite\b/,
  /\b(bye|goodbye|see\s+you|see\s+ya|that\s+s\s+all|that\s+is\s+all|we\s+re\s+done|i\s+m\s+done|im\s+done)\b/,
];

export function isFarewellIntent(text: string | null | undefined): boolean {
  const n = normalize(text ?? '');
  if (!n) return false;
  return FAREWELL_PATTERNS.some((re) => re.test(n));
}
