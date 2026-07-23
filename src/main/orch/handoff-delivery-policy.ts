/** Durable handoff delivery limits shared by rebind recovery and idle delivery. */
export const MAX_HANDOFF_DELIVERY_ATTEMPTS = 2;

export const HANDOFF_REBIND_BLOCK_MARKER =
  '[NEXUS_HANDOFF_REBIND_BLOCKED]';

export const HANDOFF_REBIND_BLOCK_CTA =
  `${HANDOFF_REBIND_BLOCK_MARKER}\n` +
  '## Handoff não reentregue\n' +
  'A entrega da sessão anterior não pode ser reutilizada com segurança pela ' +
  'sessão atual, e o reenvio automático foi interrompido.\n' +
  'Clique em “Retomar missão” para revisar a entrega e iniciar uma nova ' +
  'tentativa controlada.';
