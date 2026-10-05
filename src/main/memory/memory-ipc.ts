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
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { MEMORY_CHANNELS } from '../../shared/channels';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type {
  MemoryForgetResult,
  MemoryUiActivity,
  MemoryAttestationResult,
  MemoryNativeImportResult,
  MemoryPromoteResult,
  MemoryRecallResult,
  MemoryStatsResult,
  MemoryUiBankStats,
  MemoryUiHit,
  MemoryUiStats,
} from '../../shared/memory-ui-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { requireLiveRendererWorkspaceScope, requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  getWorkspaceMemoryStore,
  MEMORY_KINDS,
  type MemoryBankStats,
  type MemoryRecallHit,
  type WorkspaceMemoryStats,
} from './workspace-memory';
import { operatorMemoryAttestationSchema, retainOperatorMemoryAttestation } from './operator-memory-attestation';
import { importNativeMemoryFile } from './native-memory-import';
import { runPeriodicTask } from '../observability/periodic-task';

const nativeImports = new Set<number>();

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

export interface MemoryIpcDeps {
  /**
   * Mem12: handoffs de sucesso entregues/aceitos no escopo em (since, until] —
   * injetado pelo Main (registry de stores do projeto); sem ele, a atividade
   * é desconhecida.
   */
  readonly countHandoffDeliveries?: (
    scope: ProjectExecutionScope,
    sinceMs: number,
    untilMs: number,
  ) => number;
}

/**
 * Atividade do Main para o alerta "memória parada": memória ativa mais
 * recente e handoffs entregues depois dela. Falha na contagem vira `null`.
 */
function memoryActivity(
  scope: ProjectExecutionScope,
  latestMemoryAt: number | null,
  deps: MemoryIpcDeps,
): MemoryUiActivity {
  let delivered: number | null = null;
  try {
    const count = deps.countHandoffDeliveries?.(scope, latestMemoryAt ?? 0, Date.now());
    delivered = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    delivered = null;
  }
  return { latestMemoryAt, deliveredHandoffsSinceLatestMemory: delivered };
}

export function registerMemoryIpc(deps: MemoryIpcDeps = {}): void {
  ipcMain.handle(MEMORY_CHANNELS.stats, (event): MemoryStatsResult => {
    if (!memoryEnabled()) return { enabled: false };
    const scope = requireRendererWorkspaceScope(event.sender);
    const store = getWorkspaceMemoryStore(scope);
    const stats = store.stats();
    return {
      enabled: true,
      stats: toUiStats(stats),
      activity: memoryActivity(scope, store.latestActiveWorkspaceAt(), deps),
    };
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

  // F-808: só o operador (renderer autorizado do workspace) promove uma nota
  // em quarentena; nenhuma tool MCP alcança este caminho.
  ipcMain.handle(MEMORY_CHANNELS.promote, (event, raw): MemoryPromoteResult => {
    if (!memoryEnabled()) return { enabled: false };
    const { id } = forgetRequestSchema.parse(raw);
    const scope = requireRendererWorkspaceScope(event.sender);
    const promoted = getWorkspaceMemoryStore(scope).promoteMemory(id);
    return { enabled: true, promoted };
  });

  ipcMain.handle(MEMORY_CHANNELS.attest, (event, raw): MemoryAttestationResult => {
    if (!memoryEnabled()) return { enabled: false };
    const scope = requireRendererWorkspaceScope(event.sender);
    const input = operatorMemoryAttestationSchema.parse(raw);
    const result = retainOperatorMemoryAttestation(scope, input);
    return { enabled: true, id: result.id, scope: result.scope };
  });

  // No caller-supplied path: only the operator's native file picker grants this read.
  ipcMain.handle(MEMORY_CHANNELS.importNative, async (event): Promise<MemoryNativeImportResult> => {
    if (!memoryEnabled()) return { enabled: false };
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    if (nativeImports.has(event.sender.id)) throw new Error('native memory import already running');
    nativeImports.add(event.sender.id);
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = { title: 'Importar memórias nativas',
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'Memórias em texto', extensions: ['md', 'txt'] }] };
      const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      requireLiveRendererWorkspaceScope(event.sender, scope);
      let imported = 0; let deduped = 0; let skipped = 0;
      if (!selection.canceled) {
        if (selection.filePaths.length > 32) throw new Error('select at most 32 native memory files');
        await runPeriodicTask(`memory-native-import:${scope.projectId}:${event.sender.id}`, async (ctx) => {
          const guard = () => { ctx.assertCurrent(); requireLiveRendererWorkspaceScope(event.sender, scope); };
          for (const file of selection.filePaths) {
            guard();
            try {
              const result = await ctx.wait(importNativeMemoryFile(scope, file, guard));
              guard();
              if (result.deduped) deduped++; else imported++;
            } catch {
              guard(); skipped++;
            }
            await ctx.checkpoint();
          }
        }, { timeoutMs: 15_000, sliceMs: 10 });
      }
      return { enabled: true, imported, deduped, skipped, cancelled: selection.canceled };
    } finally { nativeImports.delete(event.sender.id); }
  });
}
