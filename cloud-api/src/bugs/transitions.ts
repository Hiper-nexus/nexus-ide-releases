import type { BugEventKind, BugStatus } from './constants.js';

/**
 * Máquina de estados do relato. Só o admin move o status (PATCH), e cada passo grava um evento.
 *
 * `approved` é o ponto de AUTORIZAÇÃO HUMANA da correção: só se chega nele vindo de `fix_proposed`, e o evento
 * `approved` guarda o admin que autorizou. A FASE 2 (correção automática por agente) deve exigir esse estado e
 * esse evento antes de agir. Nada nesta fase executa correção.
 */
export const STATUS_TRANSITIONS: Readonly<Record<BugStatus, readonly BugStatus[]>> = {
  new: ['triaged', 'needs_info', 'wont_fix', 'duplicate'],
  triaged: ['needs_info', 'fix_proposed', 'wont_fix', 'duplicate'],
  needs_info: ['triaged', 'wont_fix', 'duplicate'],
  fix_proposed: ['approved', 'triaged', 'wont_fix'],
  approved: ['fixed', 'released', 'fix_proposed', 'wont_fix'],
  fixed: ['released', 'triaged'],
  released: ['triaged'],
  wont_fix: ['triaged'],
  duplicate: ['triaged'],
};

export function canTransition(from: BugStatus, to: BugStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Tipo do evento na linha do tempo para uma mudança de status (a validade já foi checada por canTransition). */
export function eventKindForTransition(from: BugStatus, to: BugStatus): BugEventKind {
  if (to === 'approved') return 'approved';
  if (to === 'released') return 'released';
  if (to === 'duplicate') return 'duplicate_marked';
  if (to === 'fix_proposed' && from === 'triaged') return 'fix_proposed';
  // Recusar a proposta ou retirar a aprovação (e dispensar o relato no meio do caminho) é uma recusa explícita.
  if ((from === 'fix_proposed' || from === 'approved') && to !== 'fixed') return 'rejected';
  return 'status_changed';
}
