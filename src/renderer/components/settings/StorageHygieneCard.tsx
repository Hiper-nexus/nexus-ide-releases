import { useCallback, useEffect, useId, useState } from 'react';
import type {
  DiskPressure,
  StorageCleanupRun,
  StorageHygieneReport,
} from '../../../shared/storage-hygiene';
import { formatResourceBytes } from '../../lib/machine-resources-display';
import { MetricTile } from './ops-format';

/**
 * Armazenamento (Diagnóstico): quanto o Nexus ocupa, por categoria, e o que a
 * higiene de disco já limpou. A limpeza roda sozinha (3 h com folga, 20 min
 * com disco crítico); o botão roda agora com prazos de disco apertado.
 *
 * Doutrina aviônica: o estado vem em texto ("Disco com folga", "Disco
 * crítico"); a cor dos tiles só reforça.
 */

const REFRESH_MS = 30_000;

const PRESSURE_TONE: Record<DiskPressure, string> = { ok: 'ok', low: 'warn', critical: 'danger' };

export function formatSince(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'nunca';
  const minutes = Math.round(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} dias`;
}

function bytesLabel(bytes: number, truncated: boolean): string {
  return `${truncated ? 'mais de ' : ''}${formatResourceBytes(bytes)}`;
}

function Verdict({ report }: { report: StorageHygieneReport }) {
  const { disk, pressure } = report;
  if (!disk) {
    return (
      <p className="storage-hygiene__verdict" role="status">
        <strong>Sem leitura do disco.</strong> A limpeza segue com os prazos normais.
      </p>
    );
  }
  const free = `${formatResourceBytes(disk.freeBytes)} livres de ${formatResourceBytes(disk.totalBytes)}`;
  if (pressure === 'critical') {
    return (
      <p className="storage-hygiene__verdict" role="status">
        <strong>Disco crítico.</strong> {free}. O Nexus limpa a cada 20 min com os prazos mais curtos.
      </p>
    );
  }
  if (pressure === 'low') {
    return (
      <p className="storage-hygiene__verdict" role="status">
        <strong>Disco apertado.</strong> {free}. O Nexus encurtou os prazos de limpeza.
      </p>
    );
  }
  return (
    <p className="storage-hygiene__verdict" role="status">
      <strong>Disco com folga.</strong> {free}.
    </p>
  );
}

function runSummary(run: StorageCleanupRun | null): string {
  if (!run) return 'Ainda não rodou nesta instalação.';
  const removed = run.steps.reduce((sum, step) => sum + step.removed, 0);
  const freed = Math.max(run.freedBytes, run.diskFreeDeltaBytes ?? 0);
  const parts = [`${removed} item(ns) removido(s)`];
  if (freed > 0) parts.push(`${formatResourceBytes(freed)} liberados`);
  const failures = run.steps.filter((step) => step.error).length;
  if (failures > 0) parts.push(`${failures} passo(s) com falha`);
  return parts.join(' · ');
}

export function StorageHygieneCard() {
  const [report, setReport] = useState<StorageHygieneReport | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const refresh = useCallback(async () => {
    try {
      const next = await window.nexus?.storage?.report?.();
      if (next) setReport(next);
    } catch {
      // A próxima leitura tenta de novo; o card mostra o último relatório.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const cleanNow = async () => {
    setCleaning(true);
    setError(null);
    try {
      const next = await window.nexus.storage.cleanNow();
      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A limpeza falhou.');
    } finally {
      setCleaning(false);
    }
  };

  const busy = cleaning || report?.running === true;
  const total = report?.categories.reduce((sum, category) => sum + category.bytes, 0) ?? 0;
  const truncated = report?.categories.some((category) => category.truncated) ?? false;
  const categories = [...(report?.categories ?? [])].sort((left, right) => right.bytes - left.bytes);
  const lastStepsWithDetail = report?.lastRun?.steps.filter((step) => step.detail || step.error) ?? [];

  return (
    <section className="storage-hygiene" aria-labelledby={titleId} aria-busy={busy}>
      <div className="sys-subhead">
        <h3 className="sys-subhead__title" id={titleId}>Armazenamento</h3>
      </div>
      {report ? <Verdict report={report} /> : (
        <p className="storage-hygiene__verdict" role="status">Lendo o uso de disco…</p>
      )}
      {report && (
        <div className="ops-metric-grid">
          <MetricTile
            label="Espaço livre"
            value={report.disk ? formatResourceBytes(report.disk.freeBytes) : '—'}
            tone={PRESSURE_TONE[report.pressure]}
            detail={report.disk ? `de ${formatResourceBytes(report.disk.totalBytes)} no volume` : undefined}
          />
          <MetricTile
            label="Ocupado pelo Nexus"
            value={report.measuredAt ? bytesLabel(total, truncated) : 'medindo…'}
            detail={`Medido ${formatSince(report.measuredAt)}`}
          />
          <MetricTile
            label="Última limpeza"
            value={formatSince(report.lastRun?.finishedAt)}
            detail={runSummary(report.lastRun)}
          />
        </div>
      )}
      {categories.length > 0 && (
        <ul className="storage-hygiene__list" aria-label="Uso por categoria">
          {categories.map((category) => (
            <li key={category.id} className="storage-hygiene__row">
              <span className="storage-hygiene__label">{category.label}</span>
              <span className="storage-hygiene__bytes">{bytesLabel(category.bytes, category.truncated)}</span>
              <span className="storage-hygiene__mode">{category.managed ? 'limpeza automática' : 'mantido'}</span>
            </li>
          ))}
        </ul>
      )}
      {lastStepsWithDetail.length > 0 && (
        <ul className="storage-hygiene__notes" aria-label="Detalhes da última limpeza">
          {lastStepsWithDetail.map((step) => (
            <li key={step.id}>
              <strong>{step.label}:</strong> {step.error ?? step.detail}
            </li>
          ))}
        </ul>
      )}
      <div className="sys-actions">
        <button className="settings-btn" type="button" disabled={busy} onClick={() => void cleanNow()}>
          {busy ? 'Limpando…' : 'Limpar agora'}
        </button>
        <span className="settings-detail__hint storage-hygiene__hint">
          "Limpar agora" usa os prazos de disco apertado (cópia de agente parada há 12 h sai).
          Trabalho não salvo nunca é apagado: a cópia suja só sai depois de guardada numa ref
          {' '}<code>refs/nexus-salvage/…</code>, e a branch fica.
        </span>
        {error && <span className="settings-detail__hint" role="alert">{error}</span>}
      </div>
    </section>
  );
}
