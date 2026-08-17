/**
 * Último erro concreto de spawn de cada pane (ex.: a cerca do pty-manager
 * "exclusive auth family ... physical exit proof"). O orch-bridge só vê o
 * timeout genérico do waitForSession; com este registro ele reporta o motivo
 * real ao main em vez de "session did not start (adapter missing or spawn
 * failed)" — o operador precisa saber O QUE fazer, não que algo vago falhou.
 */
const paneSpawnErrors = new Map<string, string>();

export function recordPaneSpawnError(paneId: string, error: string): void {
  paneSpawnErrors.set(paneId, error);
}

export function clearPaneSpawnError(paneId: string): void {
  paneSpawnErrors.delete(paneId);
}

/** Lê e consome o erro gravado; null quando o pane não tem um. */
export function takePaneSpawnError(paneId: string): string | null {
  const error = paneSpawnErrors.get(paneId) ?? null;
  paneSpawnErrors.delete(paneId);
  return error;
}
