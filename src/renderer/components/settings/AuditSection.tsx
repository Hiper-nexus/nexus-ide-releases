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
          {entry.user_authorized ? 'confirmado' : 'sem grant'}
        </StatusPill>
      </div>
      <p className="settings-list__detail">
        {formatDate(entry.timestamp)} · {entry.source} · {entry.duration_ms}ms
        {entry.error ? ` · ${entry.error}` : ''}
      </p>
      {!compact && (
        <pre className="audit-row__args">{argsPreview(entry.args)}</pre>
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

  return (
    <section>
      <div className="settings-detail__split-head">
        <div>
          <SettingsSectionTitle>Auditoria</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Leitura read-only dos eventos SQLite isolados por projeto e
            checkout. Textos, comandos com segredos e tokens chegam mascarados.
          </p>
        </div>
        <button className="settings-btn" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Lendo' : 'Recarregar'}
        </button>
      </div>

      {error && <p className="settings-error">{error}</p>}
      <p className="settings-field__note">
        Fonte: {snapshot?.path ?? 'aguardando'} · lido em {formatDate(snapshot?.readAt)}
      </p>

      <h4 className="release-section-title">Confirmations</h4>
      <ul className="settings-list">
        {confirmations.length === 0 ? (
          <EmptyAuditRow>Nenhuma confirmação registrada.</EmptyAuditRow>
        ) : (
          confirmations.slice(-8).reverse().map((entry) => (
            <AuditRow key={`${entry.timestamp}-${entry.tool}-${entry.duration_ms}`} entry={entry} compact />
          ))
        )}
      </ul>

      <h4 className="release-section-title">Últimas ações</h4>
      <ul className="settings-list">
        {entries.length === 0 ? (
          <EmptyAuditRow>Audit log vazio ou ainda não criado.</EmptyAuditRow>
        ) : (
          entries.slice(-16).reverse().map((entry) => (
            <AuditRow key={`${entry.timestamp}-${entry.tool}-${entry.session}`} entry={entry} />
          ))
        )}
      </ul>
    </section>
  );
}
