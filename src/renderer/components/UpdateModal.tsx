import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update-ipc';
import { OverlayLayer } from '../overlay/overlay-layer';
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

const VISIBLE_PHASES = new Set<UpdateState['phase']>([
  'unsupported',
  'checking',
  'available',
  'downloading',
  'ready',
  'error',
]);

function summarizeUpdateState(state: UpdateState): Record<string, unknown> {
  return {
    phase: state.phase,
    source: state.source,
    currentVersion: state.currentVersion,
    availableVersion: state.available?.version,
    canInstall: state.canInstall,
    error: state.error,
  };
}

function logRendererUpdate(message: string, detail?: unknown): void {
  if (detail === undefined) {
    console.info(`[update] ${message}`);
    return;
  }
  console.info(`[update] ${message}`, detail);
}

function logRendererError(message: string, err: unknown): void {
  console.error(`[update] ${message}`, err);
}

function getUpdateButtonLabel(state: UpdateState): string {
  switch (state.phase) {
    case 'unsupported':
      return 'manual';
    case 'idle':
      return 'update';
    case 'checking':
      return 'checando';
    case 'uptodate':
      return `v${state.currentVersion}`;
    case 'available':
      return `v${state.available?.version ?? 'nova'}`;
    case 'downloading':
      return 'baixando';
    case 'ready':
      return 'reiniciar';
    case 'error':
      return 'erro';
  }
}

function getUpdateButtonTitle(state: UpdateState): string {
  switch (state.phase) {
    case 'unsupported':
      return state.error ?? 'Atualização manual necessária';
    case 'idle':
      return 'Atualizações — verificar agora';
    case 'checking':
      return 'Verificando atualizações';
    case 'uptodate':
      return `NexusIDE v${state.currentVersion} está atualizado — verificar novamente`;
    case 'available':
      return `NexusIDE v${state.available?.version ?? 'nova'} disponível`;
    case 'downloading':
      return 'Atualização baixando';
    case 'ready':
      return 'Atualização pronta — reiniciar para aplicar';
    case 'error':
      return `Atualização: ${state.error ?? 'erro'}`;
  }
}

export function isUpdateNoticeVisible(state: UpdateState): boolean {
  return VISIBLE_PHASES.has(state.phase);
}

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.nexus.update
      .getState()
      .then((s) => {
        logRendererUpdate('getState', summarizeUpdateState(s));
        if (!cancelled) setState(s);
      })
      .catch((err) => logRendererError('getState failed', err));
    const unsub = window.nexus.update.onState((next) => {
      logRendererUpdate('state', summarizeUpdateState(next));
      setState(next);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return state;
}

type UpdateStatusButtonProps = {
  state: UpdateState;
  onClick: () => void;
  alwaysVisible?: boolean;
  /** Icon-only bar chip (hide version label on narrow toolbars). */
  compact?: boolean;
};

export function UpdateStatusButton({
  state,
  onClick,
  alwaysVisible = false,
  compact = false,
}: UpdateStatusButtonProps) {
  if (!alwaysVisible && !isUpdateNoticeVisible(state)) return null;
  const title = getUpdateButtonTitle(state);
  const className = [
    'workspace-bar__btn',
    'workspace-bar__btn--update',
    `workspace-bar__btn--update-${state.phase}`,
    'update-status-btn',
    'update-status-btn--bar',
    compact ? 'update-status-btn--compact' : '',
    `update-status-btn--${state.phase}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      <span className="update-status-btn__glyph" aria-hidden="true">
        ⇪
      </span>
      {!compact && (
        <span className="update-status-btn__label">{getUpdateButtonLabel(state)}</span>
      )}
    </button>
  );
}

type Props = {
  state: UpdateState;
  onClose: () => void;
};

export function UpdateModal({ state, onClose }: Props) {
  const { phase, currentVersion, available, error, checkedAt } = state;
  const busy = phase === 'checking' || phase === 'downloading';
  const runUpdateAction = (
    action: 'install' | 'restart' | 'check',
    task: () => Promise<unknown>,
  ) => {
    logRendererUpdate(`action:${action}`, summarizeUpdateState(state));
    void task().catch((err) => logRendererError(`action:${action} failed`, err));
  };

  return (
    // H6: montado dentro da WorkspaceBar (e da LaunchScreen), este modal
    // declarava --z-confirm-class (1300) dentro de um chrome com z-index 55 —
    // número alto sem efeito nenhum. Na camada de overlay o 1300 volta a ser
    // lido entre iguais. O portal do React preserva o borbulhar de eventos,
    // então o onClick do backdrop e o stopPropagation do painel seguem iguais.
    <OverlayLayer>
      <div
        className="update-modal__backdrop overlay-scrim-glass overlay-scrim-enter"
        onClick={onClose}
      >
      <div
        className="update-modal overlay-enter"
        role="dialog"
        aria-modal="true"
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
              onClick={() =>
                runUpdateAction('install', () => window.nexus.update.install())
              }
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
              onClick={() =>
                runUpdateAction('restart', () => window.nexus.update.restart())
              }
            >
              Reiniciar agora
            </button>
          )}
          <button
            className="update-modal__btn"
            disabled={busy}
            onClick={() =>
              runUpdateAction('check', () => window.nexus.update.check())
            }
          >
            {phase === 'checking' ? 'Verificando…' : 'Verificar agora'}
          </button>
        </div>
      </div>
      </div>
    </OverlayLayer>
  );
}
