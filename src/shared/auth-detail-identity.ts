/**
 * Identidade embutida no DETALHE de autenticação ("sessão Claude viva:
 * fulano@dominio.com"). O contrato entre a sonda do main e a UI de contas é
 * texto: `emailFromAuthDetail` é o lado que lê. Viver em shared é o que
 * permite a sonda GARANTIR o formato e a UI consumir — sem duplicar regex.
 *
 * Quando o provider realmente expõe e-mail, a sonda o anexa por este helper.
 * Providers sem essa claim usam AdapterAuthStatus.sessionFingerprint apenas
 * para igualdade; nunca sintetizamos um e-mail a partir de subject/token.
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/u;

/** Extrai o primeiro e-mail de um texto de diagnóstico de autenticação. */
export function emailFromAuthDetail(
  detail: string | null | undefined,
): string | null {
  if (!detail) return null;
  const match = EMAIL_RE.exec(detail);
  return match ? match[0] : null;
}

/** Anexa a identidade ao detalhe quando ele ainda não traz e-mail. */
export function detailWithIdentity(detail: string, email?: string): string {
  if (!email || emailFromAuthDetail(detail)) return detail;
  return `${detail} · ${email}`;
}
