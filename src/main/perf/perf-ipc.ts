import { app, ipcMain } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { PerfSnapshot } from '../../shared/types';
import {
  countLiveAgentSessions,
  getLiveSessionCount,
  probePaneFootprints,
} from '../pty/pty-manager';
import { getBrowserViewCount } from '../browser/browser-manager';
import { warmPool } from '../pty/warm-pool';
import { summarizeFootprints } from '../pty/pane-footprint';
import { readPaneAdmissionLimits, sampleSystemMemory } from '../orch/pane-admission';
import { onTrusted } from '../security/trusted-ipc';
import { setPaneFootprintSubscription } from './pane-footprint-broadcast';
// Sem import de pane-registry aqui: perf-ipc é importado pelas tools de orch e
// esse edge fechava um ciclo ESM (squad-store/guided-squad-skills em TDZ).

function memoryInfo() {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
  };
}

export function collectPerfSnapshot(): PerfSnapshot {
  const mem = memoryInfo();
  return {
    capturedAt: Date.now(),
    process: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: process.uptime(),
      ...mem,
    },
    appMetrics: (typeof app?.getAppMetrics === 'function'
      ? app.getAppMetrics()
      : []
    ).map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: {
        workingSetSize: metric.memory.workingSetSize,
        peakWorkingSetSize: metric.memory.peakWorkingSetSize,
        privateBytes: metric.memory.privateBytes ?? 0,
        sharedBytes: 0,
      },
      cpu: {
        percentCPUUsage: metric.cpu.percentCPUUsage,
        idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
      },
    })),
    panes: {
      livePtySessions: getLiveSessionCount(),
      browserViews: getBrowserViewCount(),
    },
    warmPool: warmPool.getMetrics(),
  };
}

/**
 * F-572: o snapshot síncrono só vê o Electron. Esta variante pergunta ao host
 * PTY o RSS da árvore de cada pane e amostra a memória do sistema — o que
 * faltou no incidente de 16/09 (22 panes, app "leve", máquina em swap).
 */
export async function collectPerfSnapshotDetailed(): Promise<PerfSnapshot> {
  const base = collectPerfSnapshot();
  const [footprints, systemMemory] = await Promise.all([
    probePaneFootprints(),
    sampleSystemMemory().catch(() => null),
  ]);
  const limits = readPaneAdmissionLimits();
  const liveAgentPanes = countLiveAgentSessions();
  return {
    ...base,
    panes: {
      ...base.panes,
      ...(footprints
        ? {
            footprints: footprints.map((footprint) => ({ ...footprint })),
            footprintTotalRssBytes: summarizeFootprints(footprints).totalRssBytes,
          }
        : {}),
    },
    ...(systemMemory ? { systemMemory } : {}),
    paneAdmission: {
      enabled: limits.enabled,
      maxAgentPanes: limits.maxAgentPanes,
      minFreeMB: limits.minFreeMB,
      maxSwapUsedMB: limits.maxSwapUsedMB,
      liveAgentPanes,
    },
  };
}

export function registerPerfIpc(): void {
  ipcMain.handle(PERF_CHANNELS.snapshot, () => collectPerfSnapshotDetailed());
  // QLT-11: o renderer que exibe o badge de custo liga/desliga o `ps` periódico.
  onTrusted(PERF_CHANNELS.paneFootprintsWatch, (event, active) => {
    if (typeof active === 'boolean') setPaneFootprintSubscription(event.sender, active);
  });
}
