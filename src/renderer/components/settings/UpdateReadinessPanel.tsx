import { useEffect, useState } from 'react';
import type { ReleaseReadinessSnapshot } from '../../../shared/ops-ipc';
import type { UpdateState } from '../../../shared/update-ipc';
import { MetricTile, statusTone, StatusPill } from './ops-format';

export function UpdateReadinessPanel() {
  const [readiness, setReadiness] = useState<ReleaseReadinessSnapshot | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = async (checkUpdate = false) => {
    setChecking(true);
    try {
      const [nextReadiness, nextUpdate] = await Promise.all([
        window.nexus.ops.releaseReadiness(),
        checkUpdate ? window.nexus.update.check() : window.nexus.update.getState(),
      ]);
      setReadiness(nextReadiness);
      setUpdate(nextUpdate);
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
    <>
      <h4 className="release-section-title">Readiness · update</h4>
      <div className="ops-metric-grid">
        <MetricTile
          label="Updater"
          value={update?.phase ?? 'carregando'}
          tone={update?.phase === 'error' ? 'danger' : update?.phase === 'ready' ? 'ok' : 'warn'}
          detail={`source=${update?.source ?? readiness?.updateSource ?? 'none'}; install=${update?.canInstall ? 'sim' : 'dev/check-only'}`}
        />
        <MetricTile
          label="Versão"
          value={readiness?.appVersion ?? '...'}
          tone={versionCheck?.status === 'pass' ? 'ok' : 'danger'}
          detail={`package=${readiness?.packageVersion ?? '...'}; notes=${readiness?.releaseNotesVersion ?? '...'}`}
        />
      </div>
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
      <div className="settings-row">
        <button className="settings-btn" type="button" onClick={() => void refresh(true)} disabled={checking}>
          {checking ? 'Checando' : 'Checar update'}
        </button>
      </div>
    </>
  );
}
