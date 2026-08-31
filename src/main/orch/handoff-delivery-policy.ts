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

export const HANDOFF_REBIND_BLOCK_MARKER =
  '[NEXUS_HANDOFF_REBIND_BLOCKED]';

export const HANDOFF_REBIND_BLOCK_CTA =
  `${HANDOFF_REBIND_BLOCK_MARKER}\n` +
  '## Handoff não reentregue\n' +
  'A entrega da sessão anterior não pode ser reutilizada com segurança pela ' +
  'sessão atual, e o reenvio automático foi interrompido.\n' +
  'Clique em “Retomar missão” para revisar a entrega e iniciar uma nova ' +
  'tentativa controlada.';
