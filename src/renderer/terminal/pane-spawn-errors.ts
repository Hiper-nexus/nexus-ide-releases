import { clearPaneBirthElapsedForPane } from '../lib/pane-birth-display';
import { parseAccountReloginRequest, type AccountReloginRequest } from '../../shared/account-relogin';

/**
 * Último erro concreto de spawn de cada pane (ex.: a cerca do pty-manager
 * "exclusive auth family ... physical exit proof"). O orch-bridge só vê o
 * timeout genérico do waitForSession; com este registro ele reporta o motivo
 * real ao main em vez de "session did not start (adapter missing or spawn
 * failed)" — o operador precisa saber O QUE fazer, não que algo vago falhou.
 */
const paneSpawnErrors = new Map<string, string>();
/**
 * F-1642: a conta que a recusa disse precisar de login. Anda junto do erro da
 * MESMA tentativa — gravar um erro sem conta apaga a conta da anterior.
 */
const paneSpawnRelogins = new Map<string, AccountReloginRequest>();
const listeners = new Set<() => void>();

export function recordPaneSpawnError(paneId: string, error: string, relogin?: unknown): void {
  paneSpawnErrors.set(paneId, error);
  const account = parseAccountReloginRequest(relogin);
  if (account) paneSpawnRelogins.set(paneId, account);
  else paneSpawnRelogins.delete(paneId);
  clearPaneBirthElapsedForPane(paneId);
  for (const listener of listeners) listener();
}

export function clearPaneSpawnError(paneId: string): void {
  paneSpawnErrors.delete(paneId);
  paneSpawnRelogins.delete(paneId);
  for (const listener of listeners) listener();
}

/** Lê e consome o erro gravado; null quando o pane não tem um. */
export function takePaneSpawnError(paneId: string): string | null {
  const error = paneSpawnErrors.get(paneId) ?? null;
  paneSpawnErrors.delete(paneId);
  paneSpawnRelogins.delete(paneId);
  return error;
}

/** Conta a reautenticar para a última recusa deste pane, sem consumir. */
export function peekPaneSpawnRelogin(paneId: string): AccountReloginRequest | null {
  return paneSpawnRelogins.get(paneId) ?? null;
}

/**
 * Lê SEM consumir — é o que um componente React pode usar no render. `take`
 * apaga o registro e não serve para isso.
 */
export function peekPaneSpawnError(paneId: string): string | null {
  return paneSpawnErrors.get(paneId) ?? null;
}

/**
 * Assinatura para o overlay de nascimento reagir na hora em que o Main recusa
 * o spawn. Sem isto o card só mudava no próximo tick de relógio (ou nunca: a
 * recusa não muda o estado do pane em todos os caminhos).
 */
export function subscribePaneSpawnErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
