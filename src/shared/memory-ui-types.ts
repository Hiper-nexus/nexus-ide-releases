/**
 * UI contract for the workspace agentic memory panel (entrega C2).
 *
 * Dependency-free by design: the renderer and the sandboxed preload import
 * these types, so nothing here may reach into main-only modules (the engine in
 * `src/main/memory/workspace-memory.ts` pulls in better-sqlite3 / node:fs). The
 * literal unions below intentionally MIRROR MEMORY_KINDS / MEMORY_SCOPES from
 * that engine — keep them in sync if the engine's vocabulary changes.
 *
 * Every response is an enabled-envelope: when the feature flag
 * `feature.memory.workspaceMemory` is OFF the main process returns
 * `{ enabled: false }` instead of throwing, so the panel can render a calm
 * "desligado" state rather than breaking.
 */

export const MEMORY_UI_KINDS = ['fact', 'decision', 'preference', 'note'] as const;
export type MemoryUiKind = (typeof MEMORY_UI_KINDS)[number];

export const MEMORY_UI_SCOPES = ['workspace', 'global'] as const;
export type MemoryUiScope = (typeof MEMORY_UI_SCOPES)[number];

/** Aggregate counters for one memory bank (workspace or user-global). */
export interface MemoryUiBankStats {
  readonly total: number;
  readonly active: number;
  readonly byKind: Readonly<Record<MemoryUiKind, number>>;
  readonly totalRecalls: number;
}

export interface MemoryUiStats {
  readonly workspace: MemoryUiBankStats;
  readonly global: MemoryUiBankStats;
}

/** A single recall result surfaced to the panel (no filesystem paths). */
export interface MemoryUiHit {
  readonly id: string;
  readonly content: string;
  readonly kind: MemoryUiKind;
  readonly scope: MemoryUiScope;
  readonly importance: number;
  readonly source: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recallCount: number;
  readonly score: number;
}

/** Request payload for `memory:recall`. */
export interface MemoryRecallRequest {
  readonly query: string;
  readonly limit?: number;
  readonly kind?: MemoryUiKind;
}

export type MemoryStatsResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly stats: MemoryUiStats };

export type MemoryRecallResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly hits: readonly MemoryUiHit[] };

export type MemoryForgetResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly forgotten: boolean };

export type MemoryPromoteResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly promoted: boolean };

/**
 * Shape of `window.nexus.memory` exposed by the preload bridge. Declared here
 * (not only inside NexusApi) so the renderer store can type the bridge without
 * importing the whole NexusApi surface; the NexusApi wiring reuses this type.
 */
export interface MemoryBridge {
  stats(): Promise<MemoryStatsResult>;
  recall(input: MemoryRecallRequest): Promise<MemoryRecallResult>;
  forget(id: string): Promise<MemoryForgetResult>;
  /** F-808: libera uma nota em quarentena para o brief dos panes do projeto. */
  promote(id: string): Promise<MemoryPromoteResult>;
}

/** Human labels (pt-BR) for kinds — shared so panel and future surfaces agree. */
export const MEMORY_KIND_LABELS: Readonly<Record<MemoryUiKind, string>> = {
  fact: 'fato',
  decision: 'decisão',
  preference: 'preferência',
  note: 'nota',
};

export const MEMORY_SCOPE_LABELS: Readonly<Record<MemoryUiScope, string>> = {
  workspace: 'workspace',
  global: 'global',
};
