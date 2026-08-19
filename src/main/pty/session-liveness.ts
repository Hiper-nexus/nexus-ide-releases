/**
 * Liveness de sessão como verdade ÚNICA (rodada 2, R1; doutrina Orca
 * "truthful liveness" #13928/#12574): live | exited | unverifiable.
 *
 * A regra de ouro que este módulo trava: **nunca colapse 'não sei' em
 * 'morto'** — e nunca trate 'exited' como provado. No pty-manager, sessão
 * sai do mapa SOMENTE com prova física completa (root exit + inventário de
 * descendentes); 'exited' ainda registrado significa que um descendente
 * destacado pode segurar a família de auth compartilhada. Por isso:
 *
 *   · CERCA (assertExclusiveOrchestratorProcessAvailable): bloqueia em
 *     QUALQUER sessão registrada — live, exited e unverifiable. Isso não é
 *     conservadorismo acidental, é o contrato: o custo de um bloqueio a
 *     mais é um terminate com prova (segundos); o custo de um a menos é
 *     dois Maestros na mesma credencial.
 *   · FAST-LANE (liveOrchestratorSessionId): só 'live' conta como vivo;
 *     exited/unverifiable → respawn (que termina com prova antes de
 *     spawnar — P0-1, 0.32.29).
 *
 * A discordância histórica (cerca conta tudo × fast-lane conta live) não é
 * bug: são duas perguntas diferentes. Este módulo existe para que as duas
 * respostas venham da MESMA tabela de estados — adicionar um estado novo
 * sem decidir as duas perguntas não compila mais.
 */

import type { PaneSessionState } from '../../shared/types';

export type SessionLiveness = 'live' | 'exited' | 'unverifiable';

/** Estados que sustentam um processo físico atendendo a missão. */
export const LIVE_SESSION_STATES: ReadonlySet<string> = new Set([
  'busy',
  'idle',
  'spawning',
]);

/** Estados que declaram fim do processo raiz (prova física pendente). */
export const EXITED_SESSION_STATES: ReadonlySet<string> = new Set([
  'exited',
  'hibernated',
]);

export function classifySessionLiveness(
  state: PaneSessionState | string | null | undefined,
): SessionLiveness {
  if (state == null) return 'unverifiable';
  if (LIVE_SESSION_STATES.has(state)) return 'live';
  if (EXITED_SESSION_STATES.has(state)) return 'exited';
  return 'unverifiable';
}

/**
 * Contrato da CERCA: bloquear spawn de orquestrador sobre esta liveness?
 * Tudo bloqueia — ver doutrina no cabeçalho. A função existe para o teste
 * travar o contrato explicitamente e para o dia em que um estado novo
 * obriguir a decisão consciente.
 */
export function fenceBlocksOrchestratorSpawn(
  _liveness: SessionLiveness,
): boolean {
  return true;
}

/**
 * Decisão do FAST-LANE para missão running com orquestrador nesta
 * liveness: 'live' → watch (o Maestro está lá); o resto → respawn (com
 * terminate com prova antes do spawn).
 */
export function fastLaneResumeForLiveness(
  liveness: SessionLiveness,
): 'watch' | 'respawn' {
  return liveness === 'live' ? 'watch' : 'respawn';
}

/**
 * Writer liveness after spawn: the session must be physically connected
 * (liveness `live`) AND stdin must be writable. `spawning` alone is not a
 * live writer if the PTY cannot accept input.
 */
export function isConnectedAndWritable(
  liveness: SessionLiveness,
  stdinWritable: boolean,
): boolean {
  return liveness === 'live' && stdinWritable === true;
}
