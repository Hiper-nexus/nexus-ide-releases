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
    | 'effort'
    | 'orchRequestId'
    | 'id'
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
}

function clean(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function buildPtySpawnRequest(
  input: PtySpawnRequestInput,
): SpawnRequest {
  const { pane } = input;
  return {
    cwd: clean(input.cwd ?? pane.cwd),
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
    accountId: clean(input.accountId ?? pane.accountId),
    effort: clean(pane.effort),
    orchRequestId: clean(pane.orchRequestId),
    missionId: clean(input.missionId),
  };
}
