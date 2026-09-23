import { useEffect, useState } from 'react';
import type { AuditLogEntry, AuditLogSnapshot } from '../../../shared/ops-ipc';
import { argsPreview, formatDate, StatusPill } from './ops-format';
import { SettingsSectionTitle } from './SettingsSectionTitle';

function AuditRow({
  entry,
  compact = false,
}: {
  entry: AuditLogEntry;
  compact?: boolean;
}) {
  const tone =
    entry.result === 'ok'
      ? 'ok'
      : entry.result === 'denied' || entry.result === 'intent'
        ? 'warn'
        : 'danger';
  return (
    <li className="settings-list__item audit-row">
      <div className="settings-list__head">
        <span className="settings-list__title settings-list__title--mono">
          {entry.tool}
        </span>
        <StatusPill tone={tone}>{entry.result}</StatusPill>
        <StatusPill tone={entry.user_authorized ? 'ok' : 'warn'}>
          {entry.user_authorized ? 'confirmado' : 'sem confirmação registrada'}
        </StatusPill>
      </div>
      <p className="settings-list__detail">
        {formatDate(entry.timestamp)} · {entry.source} · {entry.duration_ms}ms
        {entry.error ? ` · ${entry.error}` : ''}
      </p>
      {!compact && (
        <details className="settings-advanced-field"><summary>Dados da ação</summary><pre className="audit-row__args">{argsPreview(entry.args)}</pre></details>
      )}
    </li>
  );
}

function EmptyAuditRow({ children }: { children: string }) {
  return (
    <li className="settings-list__item">
      <p className="settings-list__detail">{children}</p>
    </li>
  );
}

export function AuditSection() {
  const [snapshot, setSnapshot] = useState<AuditLogSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.nexus.ops.auditLog(80));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const entries = snapshot?.entries ?? [];
  const confirmations = entries.filter(
    (entry) =>
      entry.result !== 'intent' &&
      (entry.user_authorized || entry.result === 'denied'),
  );
  const deniedCount = entries.filter((entry) => entry.result === 'denied').length;
  const failedCount = entries.filter((entry) => entry.result === 'error').length;

  return (
    <section className="sys-section">
      <div className="settings-detail__split-head">
        <div>
          <SettingsSectionTitle>Auditoria</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Consulte as ações e confirmações deste projeto. Informações sensíveis são ocultadas.
          </p>
        </div>
        <button className="settings-btn" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Lendo…' : 'Recarregar'}
        </button>
      </div>

      {error && <p className="settings-error" role="alert">{error}</p>}

      {snapshot === null && !error ? (
        <div className="settings-skeleton" role="status" aria-label="Carregando auditoria">
          <span /><span /><span />
        </div>
      ) : (
        <>
          <div className="sys-stat-strip" aria-label="Resumo da auditoria">
            <span className="settings-chip">{entries.length} ações lidas</span>
            <span className="settings-chip settings-chip--ok">
              {confirmations.length} confirmações
            </span>
            {deniedCount > 0 && (
              <span className="settings-chip settings-chip--warn">
                {deniedCount} negadas
              </span>
            )}
            {failedCount > 0 && (
              <span className="settings-chip settings-chip--danger">
                {failedCount} com erro
              </span>
            )}
          </div>
          <details className="settings-advanced-field"><summary>Origem e horário da consulta</summary>
          <p className="settings-field__note">
            Fonte: {snapshot?.path ?? 'aguardando'} · lido em {formatDate(snapshot?.readAt)}
          </p>
          </details>
          <div className="sys-subhead">
            <h3 className="sys-subhead__title">Confirmações</h3>
            <span className="sys-subhead__meta">
              {confirmations.length === 0
                ? 'nenhuma'
                : `últimas ${Math.min(confirmations.length, 8)} de ${confirmations.length}`}
            </span>
          </div>
          <ul className="settings-list">
            {confirmations.length === 0 ? (
              <EmptyAuditRow>Nenhuma confirmação registrada.</EmptyAuditRow>
            ) : (
              confirmations.slice(-8).reverse().map((entry) => (
                <AuditRow key={`${entry.timestamp}-${entry.tool}-${entry.duration_ms}`} entry={entry} compact />
              ))
            )}
          </ul>

          <div className="sys-subhead">
            <h3 className="sys-subhead__title">Últimas ações</h3>
            <span className="sys-subhead__meta">
              {entries.length === 0
                ? 'nenhuma'
                : `últimas ${Math.min(entries.length, 16)} de ${entries.length}`}
            </span>
          </div>
          <ul className="settings-list">
            {entries.length === 0 ? (
              <EmptyAuditRow>Audit log vazio ou ainda não criado.</EmptyAuditRow>
            ) : (
              entries.slice(-16).reverse().map((entry) => (
                <AuditRow key={`${entry.timestamp}-${entry.tool}-${entry.session}`} entry={entry} />
              ))
            )}
          </ul>
        </>
      )}
    </section>
  );
}
