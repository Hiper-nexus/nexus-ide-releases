import { app, ipcMain } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { PerfSnapshot } from '../../shared/types';
import { getLiveSessionCount } from '../pty/pty-manager';
import { getBrowserViewCount } from '../browser/browser-manager';
import { warmPool } from '../pty/warm-pool';

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
    appMetrics: app.getAppMetrics().map((metric) => ({
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

export function registerPerfIpc(): void {
  ipcMain.handle(PERF_CHANNELS.snapshot, () => collectPerfSnapshot());
}
