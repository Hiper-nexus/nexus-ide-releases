import { z } from 'zod';
import { workspaceLayoutSchema } from '../../shared/ipc';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorkspaceLayout } from '../../shared/types';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

const LAYOUT_SINGLETON_ID = 1;
const MAX_LAYOUT_BYTES = 4 * 1_024 * 1_024;

const layoutRowSchema = z
  .object({
    layout_json: z.string(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type ScopedWorkspaceLayout = ScopedEntity<{
  layout: WorkspaceLayout;
  updatedAt: number;
}>;

type LayoutRow = z.infer<typeof layoutRowSchema>;

function encodeLayout(rawLayout: WorkspaceLayout): { layout: WorkspaceLayout; serialized: string } {
  const layout = workspaceLayoutSchema.parse(rawLayout);
  const serialized = JSON.stringify(layout);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LAYOUT_BYTES) {
    throw new TypeError('workspace layout must be smaller than 4 MiB');
  }
  return { layout, serialized };
}

function parsePersistedLayout(raw: string): WorkspaceLayout {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_LAYOUT_BYTES) {
      throw new Error('serialized layout exceeds 4 MiB');
    }
    return workspaceLayoutSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new ScopedStoreCorruptionError('workspace layout', { cause: error });
  }
}

export class ScopedLayoutStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  load(): ScopedWorkspaceLayout | null {
    const rawRow = this.#binding
      .readDatabase()
      .prepare(
        `SELECT layout_json, updated_at
         FROM workspace_layout
         WHERE singleton = ?`,
      )
      .get(LAYOUT_SINGLETON_ID);
    if (rawRow === undefined) return null;

    let row: LayoutRow;
    try {
      row = layoutRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('workspace layout', { cause: error });
    }
    return {
      layout: parsePersistedLayout(row.layout_json),
      updatedAt: row.updated_at,
      ...this.#binding.coordinates,
    };
  }

  save(rawLayout: WorkspaceLayout): ScopedWorkspaceLayout {
    const { layout, serialized } = encodeLayout(rawLayout);
    const updatedAt = this.#binding.now();
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO workspace_layout (singleton, layout_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at`,
      )
      .run(LAYOUT_SINGLETON_ID, serialized, updatedAt);
    this.#binding.emitChange();
    return {
      layout,
      updatedAt,
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedLayoutStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedLayoutStore {
  return new ScopedLayoutStore(runtimeManager, scope, options);
}
