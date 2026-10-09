import os from 'node:os';

/**
 * Monitor de recursos (item T3 `native/resource-monitor`).
 *
 * Primeiro corte sem o crate Rust: amostragem do sistema via `node:os`
 * (load, memória livre/total, uptime) + do processo. Puro e testável; o
 * nativo entra depois por cima da mesma interface.
 */

export interface SystemResourceSample {
  readonly sampledAt: number;
  readonly loadAvg1: number;
  readonly loadAvg5: number;
  readonly loadAvg15: number;
  readonly freeMemBytes: number;
  readonly totalMemBytes: number;
  readonly usedMemRatio: number;
  readonly uptimeSec: number;
  readonly process: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
  };
}

export interface ResourceMonitorOptions {
  readonly now?: () => number;
}

export function sampleSystemResources(
  options: ResourceMonitorOptions = {},
): SystemResourceSample {
  const now = options.now ?? Date.now;
  const load = os.loadavg();
  const free = os.freemem();
  const total = os.totalmem();
  const mem = process.memoryUsage();
  return {
    sampledAt: now(),
    loadAvg1: load[0] ?? 0,
    loadAvg5: load[1] ?? 0,
    loadAvg15: load[2] ?? 0,
    freeMemBytes: free,
    totalMemBytes: total,
    usedMemRatio: total > 0 ? (total - free) / total : 0,
    uptimeSec: os.uptime(),
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
  };
}

/**
 * Veredito de pressão (mesma linguagem do gate de panes do AGENTS.md):
 * memória disponível baixa é pressão real; swap no macOS NÃO é.
 */
export function isSystemUnderMemoryPressure(
  sample: SystemResourceSample,
  minFreeRatio = 0.15,
): boolean {
  if (sample.totalMemBytes <= 0) return false;
  return sample.freeMemBytes / sample.totalMemBytes < minFreeRatio;
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

  peakUsedMemRatio(): number {
    let peak = 0;
    for (const sample of this.#samples) {
      if (sample.usedMemRatio > peak) peak = sample.usedMemRatio;
    }
    return peak;
  }

  averageLoad1(): number {
    if (this.#samples.length === 0) return 0;
    let sum = 0;
    for (const sample of this.#samples) sum += sample.loadAvg1;
    return sum / this.#samples.length;
  }

  latest(): SystemResourceSample | null {
    return this.#samples[this.#samples.length - 1] ?? null;
  }
}
