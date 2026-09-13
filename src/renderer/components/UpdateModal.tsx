import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update-ipc';
import { CURRENT_RELEASE } from '../../shared/release-notes';
import { OverlayLayer } from '../overlay/overlay-layer';
import { CloseButton } from './CloseButton';

/** Estado mínimo offline: versão visível, sem funcionalidade de update. */
const OFFLINE_UPDATE_STATE: UpdateState = {
  phase: 'unsupported',
  currentVersion: CURRENT_RELEASE.version,
  source: 'none',
  canInstall: false,
};

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

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function getDownloadLabel(progress: UpdateState['downloadProgress']): string {
  if (!progress) return 'baixando';
  if (progress.totalBytes && progress.totalBytes > 0) {
    const pct = Math.min(
      100,
      Math.floor((progress.receivedBytes / progress.totalBytes) * 100),
    );
    return `baixando ${pct}%`;
  }
  return `baixando ${formatMib(progress.receivedBytes)}`;
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
      return getDownloadLabel(state.downloadProgress);
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
    case 'downloading': {
      const progress = state.downloadProgress;
      if (progress?.totalBytes) {
        return `Atualização baixando — ${formatMib(progress.receivedBytes)} de ${formatMib(progress.totalBytes)}`;
      }
      if (progress) {
        return `Atualização baixando — ${formatMib(progress.receivedBytes)} recebidos`;
      }
      return 'Atualização baixando';
    }
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
    // A ponte de update é opcional: contexto sem ela (harness de teste, preload
    // reduzido) não pode DERRUBAR a casca do app. Mas — ao contrário do fix
    // estreito de 2173e725 — o chip NUNCA some: sem ponte, cai no estado offline
    // que mostra a versão atual sem funcionalidade de update. "Sumiu o campo de
    // versão" resolvido de verdade (não depende de ninguém lembrar de montar).
    if (!window.nexus?.update?.getState) {
      setState(OFFLINE_UPDATE_STATE);
      return;
    }
    let cancelled = false;
    void window.nexus.update
      .getState()
      .then((s) => {
        logRendererUpdate('getState', summarizeUpdateState(s));
        if (!cancelled) setState(s);
      })
      .catch((err) => {
        logRendererError('getState failed', err);
        if (!cancelled) setState(OFFLINE_UPDATE_STATE);
      });
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
    // Portaled so the named overlay ladder governs the modal independently of
    // whichever product destination exposes the update control.
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
          {phase === 'error' && available && (
            <>
              <button
                type="button"
                className="update-modal__btn update-modal__btn--primary"
                onClick={() => {
                  const tag = available.tag || `v${available.version}`;
                  const url = `https://github.com/Hiper-nexus/nexus-ide/releases/tag/${tag}`;
                  void window.nexus?.app?.openExternal(url);
                }}
              >
                Baixar instalador (.dmg)
              </button>
              {state.canInstall && (
                <button
                  type="button"
                  className="update-modal__btn"
                  onClick={() =>
                    runUpdateAction('install', () => window.nexus.update.install())
                  }
                >
                  Tentar novamente
                </button>
              )}
            </>
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

/**
 * Chip de atualização + painel, prontos para montar.
 *
 * A composição existia e sumiu do App em 01/08 (commit `5a6cb8b8`, junto de um
 * fix de missão), deixando o painel órfão: o app passou DUAS releases sem
 * nenhuma superfície de atualizar — "a parte de atualizar o app sumiu". Voltou
 * como componente próprio para não depender de ninguém lembrar de montar as
 * três peças na mão.
 */
export function UpdateNotifier({
  alwaysVisible = false,
  compact = false,
}: {
  alwaysVisible?: boolean;
  compact?: boolean;
}) {
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  if (!state) return null;
  return (
    <>
      <UpdateStatusButton
        state={state}
        alwaysVisible={alwaysVisible}
        compact={compact}
        onClick={() => setOpen(true)}
      />
      {open && <UpdateModal state={state} onClose={() => setOpen(false)} />}
    </>
  );
}
