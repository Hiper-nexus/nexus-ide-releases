import { useEffect, useState } from 'react';
import type { ReleaseReadinessSnapshot } from '../../../shared/ops-ipc';
import type { UpdatePhase, UpdateState } from '../../../shared/update-ipc';
import { MetricTile, statusTone, StatusPill } from './ops-format';

const UPDATE_LABELS: Record<UpdatePhase, string> = {
  unsupported: 'Atualização manual', idle: 'Ainda não verificado', checking: 'Verificando',
  uptodate: 'App atualizado', available: 'Nova versão disponível', downloading: 'Baixando',
  ready: 'Pronto para reiniciar', error: 'Não foi possível atualizar',
};

export function UpdateReadinessPanel() {
  const [readiness, setReadiness] = useState<ReleaseReadinessSnapshot | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (checkUpdate = false) => {
    setChecking(true);
    setError(null);
    try {
      const [nextReadiness, nextUpdate] = await Promise.all([
        window.nexus.ops.releaseReadiness(),
        checkUpdate ? window.nexus.update.check() : window.nexus.update.getState(),
      ]);
      setReadiness(nextReadiness);
      setUpdate(nextUpdate);
    } catch {
      setReadiness(null);
      setUpdate(null);
      setError('Não foi possível consultar as atualizações. Tente novamente.');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void refresh(false);
    return window.nexus.update.onState(setUpdate);
  }, []);

  const versionCheck = readiness?.checks.find(
    (check) => check.id === 'version-alignment',
  );

  return (
    <div className="sys-group">
      <div className="sys-group__head">
        <div className="sys-group__titles">
          <h3 className="sys-group__title">Atualizações</h3>
          <p className="sys-group__hint">
            Estado do updater e alinhamento da versão instalada.
          </p>
        </div>
        <button
          className="settings-btn"
          type="button"
          onClick={() => void refresh(true)}
          disabled={checking}
        >
          {checking ? 'Verificando…' : 'Verificar atualizações'}
        </button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="ops-metric-grid">
        <MetricTile
          label="Atualização"
          value={update ? UPDATE_LABELS[update.phase] : error ? 'Indisponível' : 'Carregando'}
          tone={update?.phase === 'error' ? 'danger' : update?.phase === 'ready' ? 'ok' : 'warn'}
          detail={update?.canInstall ? 'Instalação disponível neste app.' : 'Esta instância permite consultar atualizações.'}
        />
        <MetricTile
          label="Versão"
          value={readiness?.appVersion ?? '...'}
          tone={versionCheck?.status === 'pass' ? 'ok' : 'danger'}
          detail={`package=${readiness?.packageVersion ?? '...'}; notes=${readiness?.releaseNotesVersion ?? '...'}`}
        />
      </div>
      <details className="settings-advanced-field"><summary>Verificações técnicas da instalação</summary>
      <ul className="settings-list">
        {(readiness?.checks ?? []).map((check) => (
          <li key={check.id} className="settings-list__item release-note">
            <div className="settings-list__head">
              <span className="settings-list__title">{check.label}</span>
              <StatusPill tone={statusTone(check.status)}>{check.status}</StatusPill>
            </div>
            <p className="settings-list__detail">{check.detail}</p>
          </li>
        ))}
      </ul>
      </details>
    </div>
  );
}
