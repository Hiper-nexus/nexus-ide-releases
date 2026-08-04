import { useEffect, useState } from 'react';
import type { PerfSnapshot } from '../../../shared/types';
import {
  terminalRendererPerformanceSnapshot,
  type TerminalRendererPerformanceSnapshot,
} from '../../terminal/terminal-host';
import { MetricTile } from './ops-format';

const SAMPLE_INTERVAL_MS = 1_000;

interface TerminalPerformanceSample {
  readonly fps: number;
  readonly renderer: TerminalRendererPerformanceSnapshot;
  readonly process: PerfSnapshot | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rendererCpu(snapshot: PerfSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.appMetrics
    .filter((metric) => metric.type.toLowerCase().includes('renderer'))
    .reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0);
}

function fpsTone(fps: number): 'ok' | 'warn' | 'danger' {
  if (fps >= 50) return 'ok';
  if (fps >= 30) return 'warn';
  return 'danger';
}

export function TerminalPerformanceStatus() {
  const [sample, setSample] = useState<TerminalPerformanceSample>(() => ({
    fps: 60,
    renderer: terminalRendererPerformanceSnapshot(),
    process: null,
  }));

  useEffect(() => {
    let disposed = false;
    let frameCount = 0;
    let frameId = 0;
    let lastSampleAt = performance.now();

    const tick = (now: number): void => {
      frameCount += 1;
      const elapsed = now - lastSampleAt;
      if (elapsed >= SAMPLE_INTERVAL_MS) {
        const fps = Math.min(60, Math.round((frameCount * 1_000) / elapsed));
        frameCount = 0;
        lastSampleAt = now;
        const renderer = terminalRendererPerformanceSnapshot();
        const perfApi = window.nexus?.perf;
        if (!perfApi?.snapshot) {
          setSample({ fps, renderer, process: null });
        } else {
          void perfApi
            .snapshot()
          .then((process) => {
            if (!disposed) setSample({ fps, renderer, process });
          })
          .catch(() => {
            if (!disposed) setSample({ fps, renderer, process: null });
          });
        }
      }
      if (!disposed) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
    };
  }, []);

  const { renderer, process, fps } = sample;
  const parked = Math.max(0, renderer.hosts - renderer.visibleHosts);
  const cpu = rendererCpu(process);

  return (
    <>
      <div className="ops-metric-grid" aria-label="Desempenho dos panes">
        <MetricTile
          label="Fluidez do renderer"
          value={`${fps} FPS`}
          tone={fpsTone(fps)}
          detail={`${cpu.toFixed(1)}% CPU nos processos renderer`}
        />
        <MetricTile
          label="Panes renderizados"
          value={`${renderer.visibleHosts}/${renderer.hosts}`}
          tone={parked > 0 ? 'ok' : 'neutral'}
          detail={
            renderer.performanceMode === 'adaptive'
              ? `${parked} pane(s) fora de vista estacionado(s)`
              : 'Modo qualidade mantém a pintura ativa'
          }
        />
        <MetricTile
          label="Fila de terminal"
          value={formatBytes(renderer.queuedChars)}
          tone={renderer.queuedChars > 1024 * 1024 ? 'warn' : 'ok'}
          detail={`${renderer.queuedTerminals} pane(s) · parse ${formatBytes(renderer.pendingParseChars)}`}
        />
        <MetricTile
          label="Aceleração WebGL"
          value={`${renderer.activeWebglLeases}/${renderer.hosts}`}
          tone={renderer.activeWebglLeases > 0 ? 'ok' : 'warn'}
          detail={`${process?.panes.livePtySessions ?? 0} PTY(s) vivo(s)`}
        />
      </div>
      {renderer.droppedBacklogs > 0 && (
        <p className="settings-detail__hint" role="status">
          O Nexus descartou {renderer.droppedBacklogs} backlog(s) oculto(s)
          acima de 2 MB para preservar a fluidez. O pane mantém um aviso no
          scrollback.
        </p>
      )}
    </>
  );
}
