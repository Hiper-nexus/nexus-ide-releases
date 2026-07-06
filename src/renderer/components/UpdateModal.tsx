import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update-ipc';
import { CloseButton } from './CloseButton';

/**
 * Painel de atualização — o fim do "às cegas": versão atual, última checagem,
 * versão nova com notas, e o ciclo baixar → pronto → reiniciar. O estado vem
 * inteiro do main (UpdateManager) via update:state.
 */

const PHASE_LABEL: Record<UpdateState['phase'], string> = {
  unsupported: 'atualização manual',
  idle: 'aguardando',
  checking: 'verificando…',
  uptodate: 'você está na mais recente',
  available: 'versão nova disponível',
  downloading: 'baixando…',
  ready: 'pronto para reiniciar',
  error: 'erro',
};

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.update.getState().then((s) => {
      if (!cancelled) setState(s);
    });
    const unsub = window.nexus.update.onState(setState);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return state;
}

type Props = {
  state: UpdateState;
  onClose: () => void;
};

export function UpdateModal({ state, onClose }: Props) {
  const { phase, currentVersion, available, error, checkedAt } = state;
  const busy = phase === 'checking' || phase === 'downloading';

  return (
    <div className="update-modal__backdrop" onClick={onClose}>
      <div
        className="update-modal"
        role="dialog"
        aria-label="Atualização do NexusIDE"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="update-modal__head">
          <span className="update-modal__eyebrow">ATUALIZAÇÃO</span>
          <CloseButton onClick={onClose} label="Fechar" />
        </div>

        <div className="update-modal__versions">
          <span className="update-modal__ver">
            atual <strong>v{currentVersion}</strong>
          </span>
          {available && (
            <>
              <span className="update-modal__arrow" aria-hidden="true">
                →
              </span>
              <span className="update-modal__ver update-modal__ver--new">
                nova <strong>v{available.version}</strong>
              </span>
            </>
          )}
        </div>

        <p className={`update-modal__phase update-modal__phase--${phase}`}>
          {PHASE_LABEL[phase]}
          {phase === 'uptodate' && checkedAt
            ? ` · checado ${new Date(checkedAt).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}`
            : ''}
        </p>

        {error && <p className="update-modal__error">{error}</p>}

        {available?.notes && phase !== 'ready' && (
          <pre className="update-modal__notes">{available.notes}</pre>
        )}

        <div className="update-modal__actions">
          {phase === 'available' && state.canInstall && (
            <button
              className="update-modal__btn update-modal__btn--primary"
              onClick={() => void window.nexus.update.install()}
            >
              Baixar e instalar
            </button>
          )}
          {phase === 'available' && !state.canInstall && (
            <span className="update-modal__hint">
              build de desenvolvimento — instale pelo app empacotado
            </span>
          )}
          {phase === 'ready' && (
            <button
              className="update-modal__btn update-modal__btn--primary"
              onClick={() => void window.nexus.update.restart()}
            >
              Reiniciar agora
            </button>
          )}
          <button
            className="update-modal__btn"
            disabled={busy}
            onClick={() => void window.nexus.update.check()}
          >
            {phase === 'checking' ? 'Verificando…' : 'Verificar agora'}
          </button>
        </div>
      </div>
    </div>
  );
}
