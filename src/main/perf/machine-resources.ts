/**
 * F-1172: recursos da máquina para o operador, montados a partir do monitor
 * T3 (`resource-monitor.ts`, monitor TS — o nativo Rust do T3 não foi
 * portado). Sem timer próprio: amostra quando o push perf:paneFootprints
 * (30s, só com assinante e sessão viva) ou o perf:snapshot pedem, com a
 * memória que ELES já leram para o gate. Nada de `ps`, `sysctl` ou
 * execFileSync aqui (F-764): só `os.loadavg`, `process.memoryUsage` e
 * `app.getAppMetrics`, todos baratos e síncronos.
 *
 * A janela guarda no máximo uma amostra a cada MIN_WINDOW_SPACING_MS — um
 * surto de snapshots não apaga a meia hora de histórico do pico.
 */
import { app } from 'electron';
import os from 'node:os';
import { parseMachineResources, type MachineResources } from '../../shared/machine-resources';
import {
  readPaneAdmissionLimits,
  type PaneAdmissionLimits,
  type SystemMemorySample,
} from '../orch/pane-admission';
import {
  isSystemUnderMemoryPressure,
  ResourceSampleWindow,
  sampleSystemResources,
} from './resource-monitor';

const MiB = 1024 * 1024;
/** 60 amostras × 30s do push = meia hora de janela. */
const WINDOW_SAMPLES = 60;
const MIN_WINDOW_SPACING_MS = 10_000;

export interface MachineResourceInput {
  /** Leitura do gate (sampleSystemMemory / getCachedSystemMemory). */
  readonly memory: SystemMemorySample | null;
  readonly panesRssBytes: number | null;
  readonly paneCount: number;
}

export interface MachineResourceSamplerDeps {
  readonly now: () => number;
  readonly totalMemBytes: () => number;
  readonly readLimits: () => PaneAdmissionLimits;
  /** Soma do working set do Electron; lança/null = sem leitura. */
  readonly appMemoryBytes: () => number | null;
  readonly platform?: NodeJS.Platform;
}

export interface MachineResourceSampler {
  sample(input: MachineResourceInput): MachineResources | null;
}

export function createMachineResourceSampler(deps: MachineResourceSamplerDeps): MachineResourceSampler {
  const window = new ResourceSampleWindow(WINDOW_SAMPLES);
  const platform = deps.platform ?? process.platform;
  // Windows devolve [0, 0, 0] no loadavg: 0 seria "CPU ociosa" inventada.
  const hasLoadAverage = platform !== 'win32';

  return {
    sample(input) {
      try {
        const now = deps.now();
        const current = sampleSystemResources(input.memory, {
          now: () => now,
          totalMemBytes: deps.totalMemBytes(),
        });
        const last = window.latest();
        if (!last || now - last.sampledAt >= MIN_WINDOW_SPACING_MS) window.push(current);
        const limits = deps.readLimits();
        const windowPeak = window.peakUsedMemRatio();
        const peak =
          current.usedMemRatio === null
            ? windowPeak
            : Math.max(windowPeak ?? 0, current.usedMemRatio);
        let appBytes: number | null = null;
        try {
          appBytes = deps.appMemoryBytes();
        } catch {
          appBytes = null;
        }
        return parseMachineResources({
          sampledAt: now,
          memory: {
            totalBytes: current.totalMemBytes,
            availableBytes: current.freeMemBytes,
            usedRatio: current.usedMemRatio,
            peakUsedRatio: peak,
            swapUsedBytes: current.swapUsedBytes,
            minFreeBytes: limits.minFreeMB * MiB,
          },
          cpu: {
            cores: current.cpuCount,
            loadAvg1: hasLoadAverage ? current.loadAvg1 : null,
            averageLoad1: hasLoadAverage ? window.averageLoad1() : null,
          },
          nexus: {
            appBytes,
            panesBytes: input.panesRssBytes,
            paneCount: input.paneCount,
          },
          pressure:
            current.freeMemBytes === null
              ? 'unknown'
              : isSystemUnderMemoryPressure(current, limits)
                ? 'pressure'
                : 'ok',
          admissionEnabled: limits.enabled,
          window: { samples: window.size, spanMs: window.spanMs() },
        });
      } catch {
        // Telemetria nunca derruba o push nem o snapshot.
        return null;
      }
    },
  };
}

function electronAppMemoryBytes(): number | null {
  if (typeof app?.getAppMetrics !== 'function') return null;
  let kb = 0;
  for (const metric of app.getAppMetrics()) kb += metric.memory.workingSetSize;
  return kb * 1024;
}

/** Instância do processo: uma janela só, alimentada pelo push e pelo snapshot. */
export const machineResourceSampler = createMachineResourceSampler({
  now: Date.now,
  totalMemBytes: () => os.totalmem(),
  readLimits: () => readPaneAdmissionLimits(),
  appMemoryBytes: electronAppMemoryBytes,
});
