/**
 * IPC read-first da memória agentic por workspace (entrega C2 — UI).
 *
 * Espelha a superfície das tools MCP nexus_memory_* (src/main/orch/tools-memory.ts)
 * para o renderer, SEM inventar autoridade: o escopo vem exclusivamente do
 * ProjectExecutionScope autorizado do sender (requireRendererWorkspaceScope) —
 * nunca de argumentos do renderer, exatamente como o gate faz com ctx.scope.
 *
 * `memory:stats` e `memory:recall` são read-only. `memory:forget` é a única
 * mutação: marca a memória como superseded (tombstone auditável), tratada com o
 * mesmo cuidado — zod na entrada, escopo fail-closed.
 *
 * Feature flag: quando `feature.memory.workspaceMemory` está OFF, todo handler
 * devolve `{ enabled: false }` em vez de lançar — o painel mostra o estado
 * "desligado" e nunca quebra. Nada é logado (o conteúdo pode conter segredos já
 * redigidos na escrita; a leitura jamais toca o logger).
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { MEMORY_CHANNELS } from '../../shared/channels';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type {
  MemoryForgetResult,
  MemoryRecallResult,
  MemoryStatsResult,
  MemoryUiBankStats,
  MemoryUiHit,
  MemoryUiStats,
} from '../../shared/memory-ui-types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  getWorkspaceMemoryStore,
  MEMORY_KINDS,
  type MemoryBankStats,
  type MemoryRecallHit,
  type WorkspaceMemoryStats,
} from './workspace-memory';

const recallRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(1_024),
    limit: z.number().int().min(1).max(32).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
  })
  .strict();

const forgetRequestSchema = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();

function memoryEnabled(): boolean {
  return getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory);
}

function toUiBankStats(stats: MemoryBankStats): MemoryUiBankStats {
  return {
    total: stats.total,
    active: stats.active,
    byKind: { ...stats.byKind },
    totalRecalls: stats.totalRecalls,
  };
}

function toUiStats(stats: WorkspaceMemoryStats): MemoryUiStats {
  return {
    workspace: toUiBankStats(stats.workspace),
    global: toUiBankStats(stats.global),
  };
}

/** Whitelist the fields that cross the boundary — no path/hash leaks. */
function toUiHit(hit: MemoryRecallHit): MemoryUiHit {
  return {
    id: hit.id,
    content: hit.content,
    kind: hit.kind,
    scope: hit.scope,
    importance: hit.importance,
    source: hit.source,
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
    recallCount: hit.recallCount,
    score: hit.score,
  };
}

export function registerMemoryIpc(): void {
  ipcMain.handle(MEMORY_CHANNELS.stats, (event): MemoryStatsResult => {
    if (!memoryEnabled()) return { enabled: false };
    const scope = requireRendererWorkspaceScope(event.sender);
    const stats = getWorkspaceMemoryStore(scope).stats();
    return { enabled: true, stats: toUiStats(stats) };
  });

  ipcMain.handle(MEMORY_CHANNELS.recall, (event, raw): MemoryRecallResult => {
    if (!memoryEnabled()) return { enabled: false };
    const input = recallRequestSchema.parse(raw);
    const scope = requireRendererWorkspaceScope(event.sender);
    const hits = getWorkspaceMemoryStore(scope).recall(input);
    return { enabled: true, hits: hits.map(toUiHit) };
  });

  ipcMain.handle(MEMORY_CHANNELS.forget, (event, raw): MemoryForgetResult => {
    if (!memoryEnabled()) return { enabled: false };
    const { id } = forgetRequestSchema.parse(raw);
    const scope = requireRendererWorkspaceScope(event.sender);
    const forgotten = getWorkspaceMemoryStore(scope).forget(id);
    return { enabled: true, forgotten };
  });
}
