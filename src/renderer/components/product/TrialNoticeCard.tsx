import { useEffect, useState } from 'react';

import { trialNotice } from '../../../shared/trial-notice';
import { useAccess } from '../../state/access-store';

/** O relógio do aviso só precisa de granularidade de minutos: o dia civil muda devagar. */
const REFRESH_MS = 5 * 60_000;

/**
 * Cartão compacto no rodapé da barra lateral: nos últimos 3 dias do teste diz quanto falta e leva ao
 * checkout. Some quando o acesso não é teste ou ainda falta mais que isso; depois do fim, quem fala é a
 * tela de acesso. O checkout abre no navegador, como em Configurações > Conta.
 */
export function TrialNoticeCard() {
  const { license } = useAccess();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const notice = trialNotice(license, now);
  if (!notice) return null;

  const subscribe = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.nexus.billing.openCheckout('pro');
      if (!result.ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trial-notice" role="status" aria-label={notice.detail}>
      <div className="trial-notice__text">
        <strong>{notice.label}</strong>
        <span>{failed ? 'Não abriu o checkout. Tente de novo.' : 'do seu teste do Nexus'}</span>
      </div>
      <button type="button" className="trial-notice__action" disabled={busy} onClick={() => void subscribe()}>
        {busy ? 'Abrindo…' : 'Assinar'}
      </button>
    </div>
  );
}
