/**
 * Nome padrão de uma conta salva sem rótulo digitado.
 *
 * Sem isto o produto gravava "Conta claude" — um rótulo genérico que não
 * distingue nada. Com duas contas Claude o operador via "Conta Claude" e
 * "retorno" lado a lado no seletor (print 23/08) e não tinha como saber qual
 * era qual. O e-mail da sessão viva já está no detalhe de autenticação
 * ("sessão Claude viva: fulano@dominio.com"); é dele que sai o nome.
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

/**
 * Rótulo a usar quando o operador não digitou nome.
 * Preferência: e-mail da sessão → nome do adapter. Nunca string vazia.
 */
export function defaultAccountLabel(input: {
  readonly typed: string;
  readonly adapterId: string;
  readonly adapterLabel?: string;
  readonly authDetail?: string | null;
}): string {
  const typed = input.typed.trim();
  if (typed) return typed;
  const email = emailFromAuthDetail(input.authDetail);
  if (email) return email;
  return `Conta ${input.adapterLabel?.trim() || input.adapterId}`;
}
