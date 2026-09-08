/**
 * Nome padrão de uma conta salva sem rótulo digitado.
 *
 * Sem isto o produto gravava "Conta claude" — um rótulo genérico que não
 * distingue nada. Com duas contas Claude o operador via "Conta Claude" e
 * "retorno" lado a lado no seletor (print 23/08) e não tinha como saber qual
 * era qual. O e-mail da sessão viva já está no detalhe de autenticação
 * ("sessão Claude viva: fulano@dominio.com"); é dele que sai o nome.
 */

import { emailFromAuthDetail } from '../../../shared/auth-detail-identity';

export { emailFromAuthDetail };

/**
 * Rótulo a usar quando o operador não digitou nome.
 * Preferência: e-mail da sessão → nome do adapter. Nunca string vazia.
 *
 * `taken` são os rótulos que já existem no vault desta CLI. Sem ele, uma CLI
 * que não expõe e-mail (Kimi, OpenCode, Codex em workspace) produzia "Conta
 * Codex" para TODAS as contas — o mesmo empate que o print de 23/08 mostrou
 * entre duas contas Claude. O sufixo numérico é a saída mínima: continua
 * legível e o operador renomeia quando quiser.
 */
export function defaultAccountLabel(input: {
  readonly typed: string;
  readonly adapterId: string;
  readonly adapterLabel?: string;
  readonly authDetail?: string | null;
  readonly taken?: readonly string[];
}): string {
  const typed = input.typed.trim();
  if (typed) return typed;
  const email = emailFromAuthDetail(input.authDetail);
  const base = email || `Conta ${input.adapterLabel?.trim() || input.adapterId}`;
  return firstFreeLabel(base, input.taken ?? []);
}

function firstFreeLabel(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  // ponytail: varredura linear no roster de UMA CLI (unidades, não milhares).
  for (let index = 2; index < used.size + 3; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
