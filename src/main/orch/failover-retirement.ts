/**
 * F-1480: a sessão que o failover de CONTA aposenta (`failover-mission-respawn`)
 * não morreu nem falhou — o pane só mudou de conta. Módulo-folha, sem imports:
 * o respawn e a cobrança de handoff (`worker-handoff-enforcement`) dividem o
 * rótulo da terminação e o veredito sem puxar o grafo um do outro.
 */

/** Rótulo da terminação pedida pelo respawn (lido no tap de terminação). */
export const FAILOVER_RESPAWN_TERMINATION_ORIGIN = 'failover-respawn';

type FailoverRetirementVerdictListener = (
  sessionId: string,
  replaced: boolean,
) => void;

const listeners = new Set<FailoverRetirementVerdictListener>();

export function onFailoverRetirementVerdict(
  listener: FailoverRetirementVerdictListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * O respawn diz se o pane novo nasceu (`replaced`). Sem pane novo, a saída da
 * sessão aposentada volta a ser cobrada como qualquer worker que saiu mudo.
 */
export function settleFailoverRetirement(sessionId: string, replaced: boolean): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, replaced);
    } catch (error) {
      console.warn('[failover-retirement] ouvinte do veredito falhou:', error);
    }
  }
}
