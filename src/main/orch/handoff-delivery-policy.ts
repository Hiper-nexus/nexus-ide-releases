import type { Handoff } from '../../shared/orch-types';

/** Durable handoff delivery limits shared by rebind recovery and idle delivery. */
export const MAX_HANDOFF_DELIVERY_ATTEMPTS = 3;

/**
 * Backoff entre tentativas de paste (F-112): a tentativa 2 disparava no
 * MESMO segundo da 1 — contra o mesmo PTY morto/renascendo (write falhou
 * 2× em 17:07:23 no banco real, mission-4d14c372). Um coordenador que
 * reinicia precisa de uma janela real para voltar a aceitar writes antes
 * da próxima colagem.
 */
export const HANDOFF_DELIVERY_RETRY_BACKOFF_MS = 15_000;

const DELEGATION_SUPERVISOR_AGENT = 'nexus-delegation-supervisor';

function isDiagnosticDriverHandoff(handoff: Handoff): boolean {
  // F-727: o "[travado]" do F-242 vem do supervisor de delegação e existe para
  // ACORDAR o Maestro. Barrado junto com os diagnósticos, ele só chegava ao
  // ledger e nenhum Maestro ficava sabendo do worker pendurado.
  if (handoff.fromAgent === DELEGATION_SUPERVISOR_AGENT) return false;
  // mission-driver "stalled / no progress" signals are ledger/UI diagnostics.
  // Pasting them into a busy orchestrator and then demoting the mission to
  // blocked after two failed CR attempts can kill a fully completed guided
  // run (executor+reviewer+QA already done).
  return (
    handoff.status === 'stalled' ||
    handoff.fromAgent === 'nexus-mission-driver'
  );
}

/**
 * F-925: predicado único do handoff entregável. Diagnóstico que nunca chega
 * ao PTY não segura re-arm nem o TTL do worker; success/blocked não são os
 * únicos entregáveis — progress/failed também voltam à fila.
 */
export function handoffDeliveryEligible(handoff: Handoff): boolean {
  return !isDiagnosticDriverHandoff(handoff);
}

export const HANDOFF_REBIND_BLOCK_MARKER =
  '[NEXUS_HANDOFF_REBIND_BLOCKED]';

export const HANDOFF_REBIND_BLOCK_CTA =
  `${HANDOFF_REBIND_BLOCK_MARKER}\n` +
  '## Handoff não reentregue\n' +
  'A entrega da sessão anterior não pode ser reutilizada com segurança pela ' +
  'sessão atual, e o reenvio automático foi interrompido.\n' +
  'Clique em “Retomar missão” para revisar a entrega e iniciar uma nova ' +
  'tentativa controlada.';
