/**
 * Hang watchdog do main (campanha 0.50, C7; doutrina Orca hang-watchdog em
 * worker thread — PRs #11488/#11344): o main que pendura (familia real:
 * SecItemAdd síncrono com keychain trancado, timers mortos, IPC vivo) não
 * pode ser vigiado por ele mesmo. A worker thread mede o gap do heartbeat;
 * acima do limiar, marca evidência em disco — o diagnóstico "app congelou"
 * ganha duração e carimbo.
 *
 * F-764 (A.1): além da duração, a worker liga o Profiler da main thread pelo
 * inspector durante o travamento e grava o `.cpuprofile` + as frames mais
 * quentes. A lógica da worker mora em `hang-watchdog-worker.cjs` (JS puro,
 * embutido verbatim); aqui ficam os números e a configuração que ela recebe.
 */

export const HANG_WATCHDOG_HEARTBEAT_MS = 5_000;
export const HANG_WATCHDOG_THRESHOLD_MS = 30_000;
/** Dentro do mesmo episódio a linha de travamento se repete no máximo nisso. */
export const HANG_WATCHDOG_REMARK_MS = 60_000;
/** `main-hang.ndjson` gira para `.1` acima disso. */
export const HANG_HISTORY_ROTATE_BYTES = 512 * 1024;

/** Janela do profile capturado durante o travamento. */
export const HANG_PROFILE_DURATION_MS = 3_000;
/** 1 ms: ~3 000 amostras em 3 s — o padrão do `--cpu-prof` do Node. */
export const HANG_PROFILE_SAMPLING_INTERVAL_US = 1_000;
/**
 * Folga para a main atender enable/start/stop além da janela do profile. Main
 * presa em código nativo não passa pelo ponto de interrupção do V8; depois
 * disso a captura desiste com o motivo em vez de esperar para sempre.
 */
export const HANG_PROFILE_INSPECTOR_TIMEOUT_MS = 15_000;
/** Retenção dos `.cpuprofile`: os 5 mais recentes… */
export const HANG_PROFILE_KEEP = 5;
/** …sem passar de 48 MB juntos… */
export const HANG_PROFILE_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
/** …e nenhum acima de 16 MB (o resumo no ndjson sai mesmo assim). */
export const HANG_PROFILE_MAX_BYTES = 16 * 1024 * 1024;
export const HANG_PROFILE_TOP_FRAMES = 8;
export const HANG_PROFILE_STACK_DEPTH = 6;

/** Marca do `workerData`: o mesmo arquivo carregado como módulo não liga a worker. */
export const HANG_WATCHDOG_WORKER_KIND = 'nexus-main-hang-watchdog';

export function shouldMarkHang(input: {
  readonly lastHeartbeatAt: number | null;
  readonly now: number;
  readonly thresholdMs?: number;
}): boolean {
  if (input.lastHeartbeatAt === null) return false;
  const threshold = input.thresholdMs ?? HANG_WATCHDOG_THRESHOLD_MS;
  return input.now - input.lastHeartbeatAt > threshold;
}

export interface HangMarker {
  readonly kind: 'main-thread-hang';
  readonly hangDurationMs: number;
  readonly appVersion: string;
  readonly lastHeartbeatAt: number;
  readonly detectedAt: number;
}

export function buildHangMarker(input: {
  readonly hangDurationMs: number;
  readonly version: string;
  readonly lastHeartbeatAt: number;
  readonly detectedAt?: number;
}): HangMarker {
  return {
    kind: 'main-thread-hang',
    hangDurationMs: input.hangDurationMs,
    appVersion: input.version,
    lastHeartbeatAt: input.lastHeartbeatAt,
    detectedAt: input.detectedAt ?? Date.now(),
  };
}

/** Configuração completa que a worker recebe em `workerData.config`. */
export interface HangWatchdogConfig {
  readonly logsDir: string;
  readonly version: string;
  readonly thresholdMs: number;
  readonly checkIntervalMs: number;
  readonly remarkEveryMs: number;
  readonly historyRotateBytes: number;
  readonly profileDurationMs: number;
  readonly samplingIntervalUs: number;
  readonly inspectorTimeoutMs: number;
  readonly maxProfiles: number;
  readonly maxProfilesTotalBytes: number;
  readonly maxProfileBytes: number;
  readonly topFrames: number;
  readonly stackDepth: number;
}

/** Ajustes aceitos (testes e o probe de smoke); o resto vem dos padrões. */
export type HangWatchdogTuning = Partial<
  Omit<HangWatchdogConfig, 'logsDir' | 'version'>
>;

/**
 * Monta a configuração da worker. Um ajuste inválido (não finito, negativo)
 * cai no padrão — instrumentação mal configurada não pode desligar o watchdog
 * em silêncio nem virar laço apertado. `profileDurationMs: 0` desliga só a
 * captura do profile.
 */
export function buildHangWatchdogConfig(input: {
  readonly logsDir: string;
  readonly version: string;
  readonly tuning?: HangWatchdogTuning;
}): HangWatchdogConfig {
  const tuning = input.tuning ?? {};
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const nonNegative = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    logsDir: input.logsDir,
    version: input.version,
    thresholdMs: positive(tuning.thresholdMs, HANG_WATCHDOG_THRESHOLD_MS),
    checkIntervalMs: positive(tuning.checkIntervalMs, HANG_WATCHDOG_HEARTBEAT_MS),
    remarkEveryMs: positive(tuning.remarkEveryMs, HANG_WATCHDOG_REMARK_MS),
    historyRotateBytes: positive(tuning.historyRotateBytes, HANG_HISTORY_ROTATE_BYTES),
    profileDurationMs: nonNegative(tuning.profileDurationMs, HANG_PROFILE_DURATION_MS),
    samplingIntervalUs: positive(tuning.samplingIntervalUs, HANG_PROFILE_SAMPLING_INTERVAL_US),
    inspectorTimeoutMs: positive(tuning.inspectorTimeoutMs, HANG_PROFILE_INSPECTOR_TIMEOUT_MS),
    maxProfiles: positive(tuning.maxProfiles, HANG_PROFILE_KEEP),
    maxProfilesTotalBytes: positive(tuning.maxProfilesTotalBytes, HANG_PROFILE_MAX_TOTAL_BYTES),
    maxProfileBytes: positive(tuning.maxProfileBytes, HANG_PROFILE_MAX_BYTES),
    topFrames: positive(tuning.topFrames, HANG_PROFILE_TOP_FRAMES),
    stackDepth: positive(tuning.stackDepth, HANG_PROFILE_STACK_DEPTH),
  };
}

/** Uma frame quente do profile, como sai no `main-hang.ndjson` (1-based). */
export interface HangProfileFrame {
  readonly functionName: string;
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly selfSamples: number;
  readonly selfPercent: number;
  /** Quem chamou, do mais próximo ao mais distante: `nome arquivo:linha:coluna`. */
  readonly stack: readonly string[];
}

/** Linhas que a worker grava em `main-hang.ndjson` (e repassa ao main). */
export type HangWatchdogRecord =
  | (HangMarker & { readonly eventLoop: unknown })
  | {
      readonly kind: 'main-thread-hang-profile';
      readonly appVersion: string;
      readonly lastHeartbeatAt: number;
      readonly capturedAt: number;
      readonly captureMs: number;
      readonly profilerUnavailable?: string;
      readonly sampleCount?: number;
      readonly profileDurationMs?: number | null;
      readonly topFrames?: readonly HangProfileFrame[];
      readonly profileFile?: string | null;
      readonly profileBytes?: number;
      readonly profileSkipped?: string;
      readonly profileError?: string;
    }
  | {
      readonly kind: 'main-thread-hang-recovered';
      readonly appVersion: string;
      readonly lastHeartbeatAt: number;
      readonly recoveredAt: number;
      readonly hangDurationMs: number;
    };

/** Valida a mensagem da worker antes de o main confiar nela. */
export function parseHangWatchdogMessage(message: unknown): HangWatchdogRecord | null {
  if (!message || typeof message !== 'object') return null;
  const { type, record } = message as { type?: unknown; record?: unknown };
  if (type !== 'hang-record' || !record || typeof record !== 'object') return null;
  const kind = (record as { kind?: unknown }).kind;
  if (
    kind !== 'main-thread-hang' &&
    kind !== 'main-thread-hang-profile' &&
    kind !== 'main-thread-hang-recovered'
  ) {
    return null;
  }
  return record as HangWatchdogRecord;
}
