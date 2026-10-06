/**
 * Consulta e leitura da lista de contas do /admin/. Sem DOM e sem rede: o que a tela pede e aceita é decidido
 * aqui e testado. O servidor continua sendo a autoridade (situação, parte do e-mail, página de 50, lastSeenAt).
 */

export const ACCOUNT_STATUSES = Object.freeze(['all', 'trial', 'active', 'suspended', 'expired']);
export const PAGE_LIMIT = 50;
const EMAIL_MAX = 200;
const CURSOR = /^[A-Za-z0-9_-]{1,160}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Query da lista. Status desconhecido volta para "todas"; e-mail vazio e cursor fora do formato não saem. */
export function accountsQuery({ status, email, cursor } = {}) {
  const params = new URLSearchParams({ status: ACCOUNT_STATUSES.includes(status) ? status : 'all', limit: String(PAGE_LIMIT) });
  const needle = typeof email === 'string' ? email.trim().slice(0, EMAIL_MAX) : '';
  if (needle !== '') params.set('email', needle);
  if (typeof cursor === 'string' && CURSOR.test(cursor)) params.set('cursor', cursor);
  return params.toString();
}

function validAccount(account) {
  if (!isObject(account) || typeof account.id !== 'string' || account.id === '') return false;
  if (typeof account.email !== 'string' || typeof account.role !== 'string' || typeof account.access !== 'string') return false;
  if (account.lastAppSeenAt !== undefined && account.lastAppSeenAt !== null && (typeof account.lastAppSeenAt !== 'string' || !ISO.test(account.lastAppSeenAt) || !Number.isFinite(Date.parse(account.lastAppSeenAt)))) return false;
  if (account.lastSeenAt === null) return true;
  return typeof account.lastSeenAt === 'string' && ISO.test(account.lastSeenAt) && Number.isFinite(Date.parse(account.lastSeenAt));
}

/** Página inteira ou null. Um item fora do contrato invalida a página: a lista administrativa não pode omitir gente. */
export function parseAccountsPage(data) {
  if (!isObject(data) || !Array.isArray(data.accounts) || !data.accounts.every(validAccount)) return null;
  const nextCursor = typeof data.nextCursor === 'string' && CURSOR.test(data.nextCursor) ? data.nextCursor : null;
  return { accounts: data.accounts, nextCursor };
}
