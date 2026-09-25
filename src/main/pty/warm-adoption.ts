/**
 * F-642 — quando um pane do warm pool pode servir um spawn.
 *
 * O pane warm nasce como pane do operador, sem missão nem restrição, no cwd
 * do projeto ativo, sem `paneId` e sem overrides (`warm-agent-spawner`). No
 * boot o processo já recebeu argv, env (NEXUS_PANE_ID incluso), overlay de
 * HOME, MCP e sandbox desse contrato. Reescrever papel, missão, `readOnly`,
 * allowlists, conta, modelo ou pane depois só troca o rótulo: o processo
 * continua com o que nasceu. Então só adota quem pede exatamente o contrato
 * de nascimento — todo o resto é spawn frio, que é sempre correto.
 */

import type { BoundSpawnAuthority } from '../orch/spawn-authority';
import type { SpawnRequest } from '../../shared/types';
import type { WarmSession } from './warm-pool';

/** O contexto com que o pane warm nasce. */
export const WARM_IDLE_CONTEXT = Object.freeze({
  allowedTools: null,
  allowedSkills: null,
  readOnly: false,
});

/** Campos do pedido que não chegam ao processo: tipo e geometria. */
const NEUTRAL_REQUEST_KEYS: ReadonlySet<string> = new Set(['kind', 'cols', 'rows']);

function isSet(value: unknown): boolean {
  return value !== undefined;
}

/** O pedido é o contrato de nascimento do pane warm? Fail-closed. */
export function requestMatchesWarmContract(
  req: SpawnRequest,
  overrides: object,
  authority: BoundSpawnAuthority,
): boolean {
  if (authority.source !== 'direct-user' || req.kind !== 'cli-agent') return false;
  for (const [key, value] of Object.entries(req)) {
    if (isSet(value) && !NEUTRAL_REQUEST_KEYS.has(key)) return false;
  }
  if (Object.values(overrides).some(isSet)) return false;
  const idle: Readonly<Record<string, unknown>> = WARM_IDLE_CONTEXT;
  for (const [key, value] of Object.entries(authority.context ?? {})) {
    if (!isSet(value)) continue;
    if (!(key in idle) || idle[key] !== value) return false;
  }
  return true;
}

/** O pane warm tirado do pool é deste CLI, deste projeto e deste cwd? */
export function warmSessionServes(
  warm: WarmSession,
  cli: string,
  authority: BoundSpawnAuthority,
  cwd: string,
): boolean {
  return (
    warm.cli === cli &&
    Boolean(warm.startKey) &&
    warm.cwd === cwd &&
    warm.scopeRootRealPath === authority.scope.rootRealPath
  );
}
