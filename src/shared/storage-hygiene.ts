/**
 * Higiene de disco do Nexus (contrato Main ↔ renderer).
 *
 * O Nexus gera, por desenho, artefatos grandes e descartáveis: worktrees de
 * writers, perfis de navegador por pane, caches de CLIs, mapas de orientação,
 * temporários. A higiene mede, poda e aposenta esses artefatos com prazos que
 * encolhem quando o disco aperta. Nunca apaga trabalho que só exista ali:
 * worktree suja só sai depois que a salvaguarda guardou tudo numa ref.
 */

/** Folga do volume dos dados do Nexus. A cor só reforça; o estado vem em texto. */
export type DiskPressure = 'ok' | 'low' | 'critical';

export interface DiskSpaceSnapshot {
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly sampledAt: number;
}

export type StorageCategoryId =
  | 'agent-worktrees'
  | 'browser-profiles'
  | 'provider-state'
  | 'provider-cache'
  | 'orientation-maps'
  | 'chromium-cache'
  | 'logs'
  | 'agent-memory'
  | 'session-files'
  | 'temp';

export interface StorageCategoryUsage {
  readonly id: StorageCategoryId;
  readonly label: string;
  /** Bytes alocados medidos (piso quando `truncated`). */
  readonly bytes: number;
  /** A medição bateu no orçamento de tempo/itens: o valor real é maior. */
  readonly truncated: boolean;
  /** A limpeza automática cuida desta categoria. */
  readonly managed: boolean;
}

export interface StorageCleanupStepResult {
  readonly id: string;
  readonly label: string;
  /** Itens removidos (pastas, arquivos, worktrees). */
  readonly removed: number;
  /** Bytes liberados medidos antes de remover (estimativa quando a medição truncou). */
  readonly freedBytes: number;
  /** Mantidos por proteção (em uso, trabalho não salvo, recentes demais). */
  readonly kept: number;
  /** Resumo do passo quando contagens não bastam (ex.: worktrees aposentadas). */
  readonly detail?: string;
  readonly error?: string;
}

export interface StorageCleanupRun {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly trigger: 'scheduled' | 'manual' | 'pressure';
  readonly pressure: DiskPressure;
  readonly steps: readonly StorageCleanupStepResult[];
  /** Soma de `freedBytes` dos passos. */
  readonly freedBytes: number;
  /** Variação do espaço livre no volume durante a rodada (pode incluir outros apps). */
  readonly diskFreeDeltaBytes: number | null;
}

export interface StorageHygieneReport {
  readonly disk: DiskSpaceSnapshot | null;
  readonly pressure: DiskPressure;
  readonly categories: readonly StorageCategoryUsage[];
  readonly measuredAt: number | null;
  readonly lastRun: StorageCleanupRun | null;
  readonly running: boolean;
  /** Próxima rodada automática (epoch ms), quando agendada. */
  readonly nextRunAt: number | null;
}
