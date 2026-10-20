import fs from 'node:fs';
import path from 'node:path';
import type {
  DiskSpaceSnapshot,
  StorageCategoryUsage,
  StorageCleanupRun,
  StorageCleanupStepResult,
  StorageHygieneReport,
} from '../../shared/storage-hygiene';
import { trace } from '../observability/main-trace';
import { writeFileAtomicAsync } from '../util/atomic-write';
import { diskPressureOf, sampleDiskSpace } from './disk-space';
import { measureDirUsage } from './dir-usage';
import {
  recordDiskSample,
  storageHygienePolicyFor,
  tighterPressure,
  type StorageHygienePolicy,
} from './hygiene-policy';
import {
  STORAGE_CATEGORIES,
  STORAGE_FILE_TARGETS,
  type StorageRoots,
  type StorageTarget,
  type StorageWorkspace,
} from './storage-targets';
import type { SweepOutcome } from './stale-sweep';

/** Resultado do passo de worktrees (poda leve + coleta + aposentadoria). */
export interface WorktreeHygieneOutcome {
  readonly trimmed: number;
  readonly removed: number;
  readonly retired: number;
  readonly kept: number;
  readonly scopes: number;
  /** Onde ficou o trabalho de cada aposentada (branch → ref de salvaguarda). */
  readonly retiredWorktrees?: ReadonlyArray<{ readonly branch: string; readonly ref: string; readonly commit: string }>;
}

export interface StorageHygieneDeps {
  readonly roots: StorageRoots;
  readonly liveSessionKeys: () => ReadonlySet<string>;
  readonly livePartitionNames: () => ReadonlySet<string>;
  /** Projetos abertos e missões vivas (lixo do Nexus em `<projeto>/.nexus/`). */
  readonly workspaces?: () => readonly StorageWorkspace[];
  /** Resgate de login antes de apagar HOME efêmero órfão (`false` mantém). */
  readonly rescueSessionOverlay?: (overlayDir: string) => boolean;
  /** Worktrees de writers dos escopos abertos (injetado: o registry vive em runtime/). */
  readonly worktrees?: (policy: StorageHygienePolicy, deadlineAt: number) => Promise<WorktreeHygieneOutcome>;
  /** Esvazia o cache HTTP das sessões Chromium (default + partições carregadas). */
  readonly clearHttpCaches?: () => Promise<void>;
  readonly now?: () => number;
  readonly sampleDisk?: (target: string) => Promise<DiskSpaceSnapshot | null>;
  readonly targets?: readonly StorageTarget[];
  /** Primeira rodada depois do start (boot já assentado). */
  readonly firstRunDelayMs?: number;
}

/** Orçamento de uma rodada inteira; cada passo para no prazo e o resto fica para a próxima. */
const RUN_BUDGET_MS = 6 * 60_000;
const MEASURE_BUDGET_MS = 30_000;
const MEASURE_STALE_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
const REPORT_FILE = 'storage-hygiene.json';

interface PersistedState {
  readonly version: 1;
  readonly lastRun: StorageCleanupRun | null;
  readonly categories: readonly StorageCategoryUsage[];
  readonly measuredAt: number | null;
}

function stepFromSweep(target: StorageTarget, outcome: SweepOutcome): StorageCleanupStepResult {
  return {
    id: target.id,
    label: target.label,
    removed: outcome.removed,
    freedBytes: outcome.freedBytes,
    kept: outcome.kept,
    ...(outcome.errors > 0 ? { error: `${outcome.errors} item(ns) não puderam ser removidos` } : {}),
  };
}

/** Aposentada some do disco: o relatório diz onde o trabalho ficou e como trazê-lo de volta. */
function worktreeDetail(outcome: WorktreeHygieneOutcome): string {
  const parts = [`${outcome.trimmed} aparada(s), ${outcome.retired} aposentada(s) com salvaguarda`];
  for (const retired of (outcome.retiredWorktrees ?? []).slice(0, 3)) {
    parts.push(`${retired.branch} → ${retired.ref} (git cherry-pick ${retired.commit.slice(0, 12)})`);
  }
  return parts.join('; ');
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * Higiene de disco do Nexus: uma rodada mede o volume, escolhe os prazos pela
 * folga (ok/low/critical), poda/coleta worktrees de writers, varre os demais
 * artefatos e grava o relatório. Agendada pela própria cadência da política
 * (3 h com folga, 20 min com disco crítico); "Limpar agora" roda na hora com
 * prazos no mínimo de disco apertado. Nunca lança; um passo que falha vira
 * erro no relatório e os outros seguem.
 */
export class StorageHygieneService {
  readonly #deps: StorageHygieneDeps;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #nextRunAt: number | null = null;
  #inflight: Promise<StorageCleanupRun> | null = null;
  #measuring: Promise<void> | null = null;
  #disk: DiskSpaceSnapshot | null = null;
  #state: PersistedState = { version: 1, lastRun: null, categories: [], measuredAt: null };
  #loading: Promise<void> | null = null;
  #disposed = false;

  constructor(deps: StorageHygieneDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get #reportFile(): string {
    return path.join(this.#deps.roots.userDataDir, REPORT_FILE);
  }

  /** Uma leitura só, memoizada: leitura tardia nunca sobrescreve estado mais novo. */
  #load(): Promise<void> {
    this.#loading ??= this.#readPersisted();
    return this.#loading;
  }

  async #readPersisted(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.#reportFile, 'utf8')) as Partial<PersistedState>;
      if (parsed && parsed.version === 1) {
        this.#state = {
          version: 1,
          lastRun: parsed.lastRun ?? null,
          categories: Array.isArray(parsed.categories) ? parsed.categories : [],
          measuredAt: typeof parsed.measuredAt === 'number' ? parsed.measuredAt : null,
        };
      }
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  async #persist(): Promise<void> {
    try {
      await writeFileAtomicAsync(this.#reportFile, JSON.stringify(this.#state, null, 2), 0o600);
    } catch (error) {
      console.warn('[storage-hygiene] relatório não gravado:', errorMessage(error));
    }
  }

  async #sampleDisk(): Promise<DiskSpaceSnapshot | null> {
    const sample = await (this.#deps.sampleDisk ?? sampleDiskSpace)(this.#deps.roots.userDataDir);
    if (sample) {
      this.#disk = sample;
      recordDiskSample(sample);
    }
    return sample;
  }

  /** Arma a primeira rodada (pós-boot) e as seguintes pela cadência da política. */
  start(): void {
    if (this.#disposed || this.#timer) return;
    this.#arm(this.#deps.firstRunDelayMs ?? FIRST_RUN_DELAY_MS);
  }

  #arm(delayMs: number): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#nextRunAt = this.#now() + delayMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#nextRunAt = null;
      void this.runNow('scheduled');
    }, delayMs);
    this.#timer.unref?.();
  }

  /** Rodada única por vez: quem chama durante uma rodada recebe a mesma. */
  runNow(trigger: StorageCleanupRun['trigger']): Promise<StorageCleanupRun> {
    this.#inflight ??= this.#run(trigger).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #run(trigger: StorageCleanupRun['trigger']): Promise<StorageCleanupRun> {
    await this.#load();
    const startedAt = this.#now();
    const deadlineAt = Date.now() + RUN_BUDGET_MS;
    const before = await this.#sampleDisk();
    let pressure = diskPressureOf(before);
    // Pedido explícito do operador: no mínimo os prazos de disco apertado.
    if (trigger === 'manual') pressure = tighterPressure(pressure, 'low');
    const policy = storageHygienePolicyFor(pressure);
    const steps: StorageCleanupStepResult[] = [];

    if (this.#deps.worktrees) {
      try {
        const outcome = await this.#deps.worktrees(policy, deadlineAt);
        steps.push({
          id: 'agent-worktrees',
          label: 'Worktrees de agentes',
          removed: outcome.removed,
          freedBytes: 0,
          kept: outcome.kept,
          ...(outcome.trimmed > 0 || outcome.retired > 0
            ? { detail: worktreeDetail(outcome) }
            : {}),
        });
      } catch (error) {
        steps.push({ id: 'agent-worktrees', label: 'Worktrees de agentes', removed: 0, freedBytes: 0, kept: 0,
          error: errorMessage(error) });
      }
    }

    const context = {
      roots: this.#deps.roots,
      policy,
      now: this.#now(),
      deadlineAt,
      liveSessionKeys: this.#deps.liveSessionKeys,
      livePartitionNames: this.#deps.livePartitionNames,
      workspaces: this.#deps.workspaces ?? (() => []),
      ...(this.#deps.rescueSessionOverlay ? { rescueSessionOverlay: this.#deps.rescueSessionOverlay } : {}),
    };
    for (const target of this.#deps.targets ?? STORAGE_FILE_TARGETS) {
      if (this.#disposed) break;
      try {
        steps.push(stepFromSweep(target, await target.run(context)));
      } catch (error) {
        steps.push({ id: target.id, label: target.label, removed: 0, freedBytes: 0, kept: 0, error: errorMessage(error) });
      }
    }

    if (pressure !== 'ok' && this.#deps.clearHttpCaches) {
      try {
        await this.#deps.clearHttpCaches();
        steps.push({ id: 'chromium-cache', label: 'Cache HTTP do Chromium', removed: 1, freedBytes: 0, kept: 0 });
      } catch (error) {
        steps.push({ id: 'chromium-cache', label: 'Cache HTTP do Chromium', removed: 0, freedBytes: 0, kept: 0,
          error: errorMessage(error) });
      }
    }

    const after = await this.#sampleDisk();
    const run: StorageCleanupRun = Object.freeze({
      startedAt,
      finishedAt: this.#now(),
      trigger,
      pressure,
      steps: Object.freeze(steps),
      freedBytes: steps.reduce((sum, step) => sum + step.freedBytes, 0),
      diskFreeDeltaBytes: before && after ? after.freeBytes - before.freeBytes : null,
    });
    this.#state = { ...this.#state, lastRun: run };
    await this.#persist();
    trace({
      kind: 'storage-hygiene',
      trigger,
      pressure,
      freedBytes: run.freedBytes,
      diskFreeDeltaBytes: run.diskFreeDeltaBytes ?? -1,
      durationMs: run.finishedAt - run.startedAt,
      removed: steps.reduce((sum, step) => sum + step.removed, 0),
      errors: steps.filter((step) => step.error).length,
    });
    // A cadência segue a folga DEPOIS da limpeza: disco ainda apertado volta logo.
    this.#arm(storageHygienePolicyFor(diskPressureOf(after ?? before)).cadenceMs);
    // Remedição fora do caminho da rodada (o relatório mostra a anterior até lá).
    void this.refreshMeasurements();
    return run;
  }

  /** Mede cada categoria com orçamento; uma por vez, nunca em paralelo à outra. */
  refreshMeasurements(): Promise<void> {
    this.#measuring ??= this.#measure().finally(() => {
      this.#measuring = null;
    });
    return this.#measuring;
  }

  async #measure(): Promise<void> {
    await this.#load();
    const deadline = Date.now() + MEASURE_BUDGET_MS;
    const categories: StorageCategoryUsage[] = [];
    const definitions = STORAGE_CATEGORIES;
    for (const [index, definition] of definitions.entries()) {
      // Fatia justa do que sobrou do orçamento para cada categoria restante.
      const share = Math.max(500, (deadline - Date.now()) / (definitions.length - index));
      const categoryDeadline = Math.min(deadline, Date.now() + share);
      let bytes = 0;
      let truncated = false;
      for (const target of await definition.paths(this.#deps.roots)) {
        const usage = await measureDirUsage(target, { deadlineAt: categoryDeadline });
        bytes += usage.bytes;
        truncated ||= usage.truncated;
      }
      categories.push({ id: definition.id, label: definition.label, bytes, truncated, managed: definition.managed });
    }
    await this.#sampleDisk();
    this.#state = { ...this.#state, categories, measuredAt: this.#now() };
    await this.#persist();
  }

  async report(): Promise<StorageHygieneReport> {
    await this.#load();
    if (!this.#disk) await this.#sampleDisk();
    const measuredAt = this.#state.measuredAt;
    if (measuredAt === null || this.#now() - measuredAt > MEASURE_STALE_MS) void this.refreshMeasurements();
    return Object.freeze({
      disk: this.#disk,
      pressure: diskPressureOf(this.#disk),
      categories: this.#state.categories,
      measuredAt,
      lastRun: this.#state.lastRun,
      running: this.#inflight !== null,
      nextRunAt: this.#nextRunAt,
    });
  }

  /** Espera a rodada/medição em curso (testes e encerramento ordenado). */
  async idle(): Promise<void> {
    await Promise.allSettled([this.#inflight, this.#measuring]);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }
}

let service: StorageHygieneService | null = null;

export function configureStorageHygiene(deps: StorageHygieneDeps): StorageHygieneService {
  service?.dispose();
  service = new StorageHygieneService(deps);
  return service;
}
