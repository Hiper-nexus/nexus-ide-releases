/**
 * F-795 — `nexus_handoff_submit` EM VOO por sessão.
 *
 * Quando o Main fica lento, o agente desiste antes do Main (timeout do shim,
 * da ponte stdio) e guarda o handoff no spool. O pedido original pode ainda
 * estar no handler e commitar logo depois. A ingestão do spool consulta este
 * registro e ADIA a sessão enquanto houver submit dela em andamento; o fim do
 * submit avisa os inscritos para reprocessar — e aí a deduplicação pelo
 * digest do payload cru enxerga o handoff que o original gravou.
 *
 * Módulo sem dependências de propósito: o spool o importa sem puxar o PTY.
 */

const inFlightBySession = new Map<string, number>();
const settledListeners = new Set<(sessionId: string) => void>();

/** Marca um submit em voo; o retorno solta a marca (idempotente). */
export function beginHandoffSubmitInFlight(sessionId: string): () => void {
  inFlightBySession.set(sessionId, (inFlightBySession.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inFlightBySession.get(sessionId) ?? 1) - 1;
    if (remaining > 0) inFlightBySession.set(sessionId, remaining);
    else inFlightBySession.delete(sessionId);
    for (const listener of [...settledListeners]) {
      try {
        listener(sessionId);
      } catch (error) {
        console.warn('[handoff-submit] ouvinte de fim de submit falhou:', error);
      }
    }
  };
}

export function hasHandoffSubmitInFlight(sessionId: string): boolean {
  return (inFlightBySession.get(sessionId) ?? 0) > 0;
}

/** O spool se inscreve aqui para reprocessar a sessão adiada. */
export function onHandoffSubmitSettled(listener: (sessionId: string) => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

/** Testes. */
export function resetHandoffSubmitInFlightForTests(): void {
  inFlightBySession.clear();
  settledListeners.clear();
}
