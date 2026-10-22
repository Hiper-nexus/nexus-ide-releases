import type { PaneModel } from '../../shared/types';
import type { SpawnRequest } from '../../shared/surface-payload-types';
import { migrateModelId } from '../../shared/model-defaults';

/**
 * Monta o payload do spawn PTY no contrato zod do main
 * (`spawnRequestSchema`): strings vazias viram `undefined`.
 *
 * Adapter sem catálogo de modelos (muse: `default: ''`) gera panes com
 * `model: ''` — e `min(1)` rejeitava o pedido inteiro com o opaco
 * "[nexus] failed to start: invalid spawn request". O main sabe subir sem
 * flag de modelo; o que não pode viajar é a string vazia.
 */
export interface PtySpawnRequestInput {
  readonly pane: Pick<
    PaneModel,
    | 'kind'
    | 'cwd'
    | 'adapterId'
    | 'model'
    | 'accountId'
    | 'accountSelection'
    | 'missionId'
    | 'role'
    | 'effort'
    | 'orchRequestId'
    | 'id'
    | 'spaceId'
    | 'isolateSpace'
  >;
  readonly cols: number;
  readonly rows: number;
  /** cwd já resolvido pelo chamador (fallback workspace); vence pane.cwd. */
  readonly cwd?: string;
  /** Shell já resolvido pelo chamador (ou undefined). */
  readonly shell?: string;
  readonly resume: boolean;
  readonly resumeLatestOnly: boolean;
  readonly restorePersistedAuthority: boolean;
  readonly missionId?: string;
  readonly accountId?: string;
  /** Recovery chose this target; its current spawn must not select another account. */
  readonly preserveAccount?: boolean;
  /** F-213: espera do renderer até a chamada (telemetria). */
  readonly rendererWaitMs?: number;
}

function clean(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function buildPtySpawnRequest(
  input: PtySpawnRequestInput,
): SpawnRequest {
  const { pane } = input;
  // A saved automatic choice is an identity for resume, not a permanent pin.
  // Only Main selects the replacement. Mission authority and explicit targets
  // (including failover) must pass through unchanged.
  const reselectAccount = pane.kind === 'cli-agent' && pane.adapterId === 'claude' &&
    pane.accountSelection === 'automatic' &&
    !input.resume && !input.resumeLatestOnly && !input.restorePersistedAuthority && !input.preserveAccount &&
    !input.missionId && !pane.missionId && !pane.orchRequestId && !pane.role &&
    (!input.accountId || input.accountId === pane.accountId);
  return {
    cwd: clean(input.cwd ?? pane.cwd),
    ...(pane.isolateSpace && pane.spaceId ? { worktreeSpaceId: pane.spaceId } : {}),
    shell: clean(input.shell),
    cols: input.cols,
    rows: input.rows,
    kind: pane.kind === 'cli-agent' ? 'cli-agent' : 'shell',
    resume: input.resume,
    resumeLatestOnly: input.resumeLatestOnly,
    restorePersistedAuthority: input.restorePersistedAuthority,
    paneId: pane.id,
    adapterId: clean(pane.adapterId),
    model: clean(migrateModelId(pane.model)),
    accountId: reselectAccount ? undefined : clean(input.accountId ?? pane.accountId),
    effort: clean(pane.effort),
    orchRequestId: clean(pane.orchRequestId),
    missionId: clean(input.missionId),
    ...(input.rendererWaitMs !== undefined
      ? { rendererWaitMs: input.rendererWaitMs }
      : {}),
  };
}
