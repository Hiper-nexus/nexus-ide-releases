/**
 * Criador de CLI ocioso para o warm pool (paridade Overclock warm-pool).
 *
 * O `take`/`retarget` já vive no `spawnAgentSession`; este módulo registra
 * QUEM sabe pré-bootar um CLI sem missão para o pool repondo. Sem um provider
 * de escopo (workspace ativo), o criador devolve `null` — o pool fica vazio e
 * o spawn segue frio. Nunca inventa cwd.
 */

import type { BoundSpawnAuthority } from '../orch/spawn-authority';
import type { ProjectExecutionScope, SpawnRequest } from '../../shared/types';
import type { Adapter } from '../../shared/adapter-types';
import type { WarmSession } from './warm-pool';
import { WARM_IDLE_CONTEXT } from './warm-adoption';
import {
  setWarmAgentSpawner,
  spawnAgentSession,
  warmSpawnInProgress,
} from './pty-manager';

export interface WarmSpawnContext {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly cwd: string;
}

export type WarmScopeProvider = () => WarmSpawnContext | null;

function idleWarmAuthority(ctx: WarmSpawnContext): BoundSpawnAuthority {
  return {
    source: 'direct-user',
    // Pane warm nasce sem missão/role e só serve um pedido com este mesmo
    // contrato (F-642) — a adoção nunca troca o papel de um processo vivo.
    context: { ...WARM_IDLE_CONTEXT },
    scope: ctx.scope,
    cwd: ctx.cwd,
  };
}

/**
 * Registra o criador padrão. `resolveAdapter`/`resolveContext` são lazy:
 * adapters e workspace só existem depois do boot do app.
 */
export function registerWarmAgentSpawner(deps: {
  resolveAdapter: (cli: string) => Adapter | null;
  resolveContext: WarmScopeProvider;
}): void {
  setWarmAgentSpawner(async (cli: string): Promise<WarmSession | null> => {
    if (warmSpawnInProgress()) return null;
    const adapter = deps.resolveAdapter(cli);
    if (!adapter || adapter.kind !== 'cli-pty') return null;
    const ctx = deps.resolveContext();
    if (!ctx) return null;
    const authority = idleWarmAuthority(ctx);
    const req = {
      kind: 'cli-agent',
      cols: 80,
      rows: 24,
    } as SpawnRequest;
    try {
      const spawned = spawnAgentSession(null, req, adapter, {}, authority);
      if (!spawned.sessionId || !spawned.startKey) {
        // Sem startKey o lease não prova dono — não entra no pool.
        return null;
      }
      return {
        sessionId: spawned.sessionId,
        startKey: spawned.startKey,
        cli: adapter.id,
        bornAtMs: Date.now(),
        cwd: ctx.cwd,
        scopeRootRealPath: ctx.scope.rootRealPath,
      };
    } catch (err) {
      console.warn('[warm-pool] boot falhou pane=', err);
      return null;
    }
  });
}
