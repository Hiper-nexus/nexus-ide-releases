import type { DiskPressure, DiskSpaceSnapshot } from '../../shared/storage-hygiene';
import { diskPressureOf } from './disk-space';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Prazos de retenção da higiene de disco. Cada prazo conta desde a última
 * atividade observada (mtime mais novo, `updatedAt` do registro). Os três
 * níveis só encolhem prazos — nenhuma proteção (em uso, trabalho não salvo,
 * sessão viva) depende da pressão.
 */
export interface StorageHygienePolicy {
  readonly pressure: DiskPressure;
  /** Worktree de writer liberado: apaga caches ignorados (.nexus-cache, .vite…). */
  readonly paneWorktreeTrimAfterMs: number;
  /** Worktree LIMPA de writer liberado sai (a branch fica). */
  readonly paneWorktreeMinIdleMs: number;
  /** Worktree suja sai depois da salvaguarda completa (ref + branch ficam). */
  readonly paneWorktreeRetireAfterMs: number;
  /** Perfil Chromium de pane de navegador sem uso. */
  readonly browserPartitionMaxIdleMs: number;
  /** Mapa de orientação de um escopo que não é reconstruído há tanto tempo. */
  readonly orientationMaxIdleMs: number;
  /** Snapshots de desfazer das CLIs (MiMo/opencode) por worktree. */
  readonly providerSnapshotMaxIdleMs: number;
  /** HOME efêmero e config MCP de sessão que não está viva neste processo. */
  readonly sessionArtifactMaxIdleMs: number;
  /** Arquivos colados/soltos nos panes e anexos de missão (fora do Git). */
  readonly droppedFilesMaxIdleMs: number;
  /** Caixas de correio de swarm (`<projeto>/.nexus/swarms/<missão>`) sem atividade. */
  readonly missionScratchMaxIdleMs: number;
  /** Briefs de spawn órfãos (crash antes do fim do pane). */
  readonly briefMaxIdleMs: number;
  /** Pastas `nexus-*` no temporário do sistema (o Windows não limpa sozinho). */
  readonly tempMaxIdleMs: number;
  /** Cópias do runtime.sqlite3 antes de cada migração de esquema. */
  readonly runtimeSchemaBackupsKept: number;
  /** Intervalo até a próxima rodada automática. */
  readonly cadenceMs: number;
}

const POLICIES: Readonly<Record<DiskPressure, StorageHygienePolicy>> = Object.freeze({
  ok: Object.freeze({
    pressure: 'ok',
    paneWorktreeTrimAfterMs: HOUR,
    paneWorktreeMinIdleMs: 12 * HOUR,
    paneWorktreeRetireAfterMs: 2 * DAY,
    browserPartitionMaxIdleMs: 21 * DAY,
    orientationMaxIdleMs: 21 * DAY,
    providerSnapshotMaxIdleMs: 7 * DAY,
    sessionArtifactMaxIdleMs: 3 * DAY,
    droppedFilesMaxIdleMs: 30 * DAY,
    missionScratchMaxIdleMs: 14 * DAY,
    briefMaxIdleMs: 3 * DAY,
    tempMaxIdleMs: 3 * DAY,
    runtimeSchemaBackupsKept: 3,
    cadenceMs: 3 * HOUR,
  }),
  low: Object.freeze({
    pressure: 'low',
    paneWorktreeTrimAfterMs: 15 * MINUTE,
    paneWorktreeMinIdleMs: 2 * HOUR,
    paneWorktreeRetireAfterMs: 12 * HOUR,
    browserPartitionMaxIdleMs: 7 * DAY,
    orientationMaxIdleMs: 7 * DAY,
    providerSnapshotMaxIdleMs: 2 * DAY,
    sessionArtifactMaxIdleMs: DAY,
    droppedFilesMaxIdleMs: 7 * DAY,
    missionScratchMaxIdleMs: 3 * DAY,
    briefMaxIdleMs: DAY,
    tempMaxIdleMs: DAY,
    runtimeSchemaBackupsKept: 2,
    cadenceMs: HOUR,
  }),
  critical: Object.freeze({
    pressure: 'critical',
    paneWorktreeTrimAfterMs: 5 * MINUTE,
    paneWorktreeMinIdleMs: 30 * MINUTE,
    paneWorktreeRetireAfterMs: 2 * HOUR,
    browserPartitionMaxIdleMs: 2 * DAY,
    orientationMaxIdleMs: 2 * DAY,
    providerSnapshotMaxIdleMs: 12 * HOUR,
    sessionArtifactMaxIdleMs: 12 * HOUR,
    droppedFilesMaxIdleMs: 2 * DAY,
    missionScratchMaxIdleMs: DAY,
    briefMaxIdleMs: 6 * HOUR,
    // Piso de 1 dia: o que pesa no temporário é sempre velho; o recente pode
    // ser de um pane vivo (ZDOTDIR, perfil de sandbox).
    tempMaxIdleMs: DAY,
    runtimeSchemaBackupsKept: 1,
    cadenceMs: 20 * MINUTE,
  }),
});

const RANK: Readonly<Record<DiskPressure, number>> = { ok: 0, low: 1, critical: 2 };

export function storageHygienePolicyFor(pressure: DiskPressure): StorageHygienePolicy {
  return POLICIES[pressure];
}

/** O nível mais apertado dos dois (limpeza manual nunca é mais branda que a automática). */
export function tighterPressure(left: DiskPressure, right: DiskPressure): DiskPressure {
  return RANK[left] >= RANK[right] ? left : right;
}

let lastDiskSample: DiskSpaceSnapshot | null = null;

/** O serviço publica cada leitura do volume; os coletores leem a política dela. */
export function recordDiskSample(sample: DiskSpaceSnapshot | null): void {
  if (sample) lastDiskSample = sample;
}

/** Política vigente pela última leitura do volume (sem leitura: prazos normais). */
export function currentStorageHygienePolicy(): StorageHygienePolicy {
  return storageHygienePolicyFor(diskPressureOf(lastDiskSample));
}

export function resetStorageHygienePolicyForTest(): void {
  lastDiskSample = null;
}
