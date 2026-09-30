import { assertLicenseAccess } from '../license-enforcement';
import { LicenseError } from '../../shared/license-errors';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  SyncEntityType,
  SyncMutation,
} from '../../../shared/sync-contract';
import { syncProjectIdSchema } from '../../../shared/sync-contract';
import { createHttpSyncBackendFromEnvironment } from './http-sync-backend';
import {
  OptimisticSyncEngine,
  type SyncBackend,
  type SyncPublishResult,
} from './sync-engine';

export type SyncServerStatus =
  | 'unconfigured'
  | 'reachable'
  | 'unreachable';

export interface SyncRuntimeStatus {
  readonly available: boolean;
  readonly projectId: string;
  readonly serverStatus: SyncServerStatus;
  readonly revision: number | null;
  readonly entityCount: number;
  readonly entityTypes: Readonly<Partial<Record<SyncEntityType, number>>>;
}

export interface SyncRuntimeCapability {
  readonly backendConfigured: boolean;
}

export interface SyncPublishInput {
  readonly projectId: string;
  readonly expectedRemoteRevision: number;
  readonly mutations: readonly SyncMutation[];
}

interface SyncRuntime {
  readonly backend: SyncBackend | null;
  readonly engine: OptimisticSyncEngine | null;
}

export class SyncRuntimeNotConfiguredError extends Error {
  constructor() {
    super('sync runtime is not configured');
    this.name = 'SyncRuntimeNotConfiguredError';
  }
}

let runtime: SyncRuntime | null = null;

function frozenCapability(backendConfigured: boolean): SyncRuntimeCapability {
  return Object.freeze({ backendConfigured });
}

function requireRuntime(): SyncRuntime {
  if (!runtime) throw new SyncRuntimeNotConfiguredError();
  return runtime;
}

function emptyStatus(
  projectId: string,
  serverStatus: Exclude<SyncServerStatus, 'reachable'>,
): SyncRuntimeStatus {
  return Object.freeze({
    available: false,
    projectId,
    serverStatus,
    revision: null,
    entityCount: 0,
    entityTypes: Object.freeze({}),
  });
}

export function configureSyncRuntime(
  options: {
    readonly backend?: SyncBackend | null;
    readonly env?: Record<string, string | undefined>;
  } = {},
): SyncRuntimeCapability {
  disposeSyncRuntime();
  const backend =
    options.backend === undefined
      ? createHttpSyncBackendFromEnvironment(options.env)
      : options.backend;
  runtime = Object.freeze({
    backend,
    engine: backend ? new OptimisticSyncEngine(backend) : null,
  });
  return frozenCapability(backend !== null);
}

export function getSyncRuntimeCapability(): SyncRuntimeCapability {
  return frozenCapability(requireRuntime().backend !== null);
}

export async function inspectSyncRuntime(
  scope: Pick<ProjectExecutionScope, 'projectId'>,
): Promise<SyncRuntimeStatus> {
  const projectId = syncProjectIdSchema.parse(scope.projectId);
  const { backend } = requireRuntime();
  if (!backend) return emptyStatus(projectId, 'unconfigured');
  try {
    const state = await backend.read(projectId);
    const counts: Partial<Record<SyncEntityType, number>> = {};
    for (const entity of state.entities) {
      counts[entity.entityType] = (counts[entity.entityType] ?? 0) + 1;
    }
    return Object.freeze({
      available: true,
      projectId,
      serverStatus: 'reachable',
      revision: state.revision,
      entityCount: state.entities.length,
      entityTypes: Object.freeze(
        Object.fromEntries(
          Object.entries(counts).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
    });
  } catch (error) {
    if (error instanceof LicenseError) throw error;
    return emptyStatus(projectId, 'unreachable');
  }
}

/** Main-owned publication boundary. No MCP/renderer surface exposes this API. */
export async function publishMainOwnedSync(
  scope: Pick<ProjectExecutionScope, 'projectId'>,
  input: SyncPublishInput,
): Promise<SyncPublishResult> {
  assertLicenseAccess('cloudSync');
  const projectId = syncProjectIdSchema.parse(scope.projectId);
  if (syncProjectIdSchema.parse(input.projectId) !== projectId) {
    throw new Error('sync project differs from execution scope');
  }
  const { engine } = requireRuntime();
  if (!engine) throw new Error('sync backend is not configured');
  return engine.publish({ ...input, projectId });
}

export function disposeSyncRuntime(): void {
  runtime = null;
}
