/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/server/src/diagnostics/ProcessResourceMonitor.ts.
 * Nexus changes: the native (Rust) monitor was not ported — this is the TS
 * monitor in production (F-1172): node:os load/CPU count + the pane admission
 * gate's own memory reading, sampled by main/perf/machine-resources.ts.
 */
import os from 'node:os';
import {
  isUnderMemoryPressure,
  type PaneAdmissionLimits,
  type SystemMemorySample,
} from '../orch/pane-admission';

/**
 * Monitor de recursos (item T3 `native/resource-monitor`).
 *
 * Sem o crate Rust: load/núcleos via `node:os` + processo. A memória
 * disponível NÃO sai do `os.freemem()` — no macOS ele conta só páginas
 * livres (sem cache recuperável) e acusava pressão numa máquina saudável,
 * divergindo do gate de admissão de panes. Quem chama passa a MESMA leitura
 * do gate (`sampleSystemMemory`/`getCachedSystemMemory`: memorystatus no
 * macOS, `available` no Linux); sem leitura, a memória fica desconhecida.
 */

const MiB = 1024 * 1024;

export interface SystemResourceSample {
  readonly sampledAt: number;
  readonly loadAvg1: number;
  readonly loadAvg5: number;
  readonly loadAvg15: number;
  readonly cpuCount: number;
  /** Memória disponível segundo o gate; null = gate sem leitura. */
  readonly freeMemBytes: number | null;
  readonly totalMemBytes: number;
  readonly usedMemRatio: number | null;
  readonly swapUsedBytes: number | null;
  readonly uptimeSec: number;
  readonly process: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
  };
}

export interface ResourceMonitorOptions {
  readonly now?: () => number;
  /** Total físico; padrão `os.totalmem()` (o mesmo que dimensiona os limites do gate). */
  readonly totalMemBytes?: number;
}

function cpuCount(): number {
  try {
    const parallelism = (os as { availableParallelism?: () => number }).availableParallelism;
    return typeof parallelism === 'function' ? parallelism() : os.cpus().length;
  } catch {
    return 0;
  }
}

export function sampleSystemResources(
  memory: SystemMemorySample | null,
  options: ResourceMonitorOptions = {},
): SystemResourceSample {
  const now = options.now ?? Date.now;
  const load = os.loadavg();
  const total = options.totalMemBytes ?? os.totalmem();
  const free =
    memory?.freeMB !== null && memory?.freeMB !== undefined && Number.isFinite(memory.freeMB)
      ? Math.min(total, Math.max(0, memory.freeMB * MiB))
      : null;
  const swap =
    memory?.swapUsedMB !== null && memory?.swapUsedMB !== undefined && Number.isFinite(memory.swapUsedMB)
      ? Math.max(0, memory.swapUsedMB * MiB)
      : null;
  const mem = process.memoryUsage();
  return {
    sampledAt: now(),
    loadAvg1: load[0] ?? 0,
    loadAvg5: load[1] ?? 0,
    loadAvg15: load[2] ?? 0,
    cpuCount: cpuCount(),
    freeMemBytes: free,
    totalMemBytes: total,
    usedMemRatio: free !== null && total > 0 ? (total - free) / total : null,
    swapUsedBytes: swap,
    uptimeSec: os.uptime(),
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
  };
}

/**
 * Veredito de pressão com os MESMOS limiares do gate de admissão
 * (`isUnderMemoryPressure`): disponível abaixo da reserva mínima é pressão;
 * swap só conta onde a máquina armou o gate dela. Sem leitura, nunca inventa.
 */
export function isSystemUnderMemoryPressure(
  sample: SystemResourceSample,
  limits: PaneAdmissionLimits,
): boolean {
  if (sample.freeMemBytes === null) return false;
  return isUnderMemoryPressure(
    {
      freeMB: sample.freeMemBytes / MiB,
      swapUsedMB: sample.swapUsedBytes === null ? null : sample.swapUsedBytes / MiB,
    },
    limits,
  );
}

/**
 * Janela deslizante de amostras para tendências (pico, média).
 * Não armazena mais que `maxSamples`.
 */
export class ResourceSampleWindow {
  readonly #samples: SystemResourceSample[] = [];
  readonly #max: number;

  constructor(maxSamples = 60) {
    this.#max = Math.max(1, Math.floor(maxSamples));
  }

  push(sample: SystemResourceSample): void {
    this.#samples.push(sample);
    while (this.#samples.length > this.#max) this.#samples.shift();
  }

  get size(): number {
    return this.#samples.length;
  }

  /** Maior uso de memória na janela; null quando nenhuma amostra tinha leitura. */
  peakUsedMemRatio(): number | null {
    let peak: number | null = null;
    for (const sample of this.#samples) {
      if (sample.usedMemRatio === null) continue;
      if (peak === null || sample.usedMemRatio > peak) peak = sample.usedMemRatio;
    }
    return peak;
  }

  averageLoad1(): number {
    if (this.#samples.length === 0) return 0;
    let sum = 0;
    for (const sample of this.#samples) sum += sample.loadAvg1;
    return sum / this.#samples.length;
  }

  /** Tempo coberto entre a amostra mais velha e a mais nova. */
  spanMs(): number {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    return first && last ? Math.max(0, last.sampledAt - first.sampledAt) : 0;
  }

  latest(): SystemResourceSample | null {
    return this.#samples[this.#samples.length - 1] ?? null;
  }
}
