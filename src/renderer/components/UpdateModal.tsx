import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update-ipc';
import { CURRENT_RELEASE } from '../../shared/release-notes';
import { OverlayLayer } from '../overlay/overlay-layer';
import { CloseButton } from './CloseButton';
import { UpdateEverythingDialog } from './UpdateEverythingDialog';

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
        if (!cancelled) {
          setState(s);
          if (
            window.nexus?.update?.check &&
            (s.phase === 'idle' || !s.checkedAt || Date.now() - s.checkedAt > 15 * 60 * 1000)
          ) {
            void window.nexus.update.check().catch((err) => {
              logRendererError('background check failed', err);
            });
          }
        }
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
  const { phase, currentVersion, available, error, checkedAt, manual } = state;
  const busy = phase === 'checking' || phase === 'downloading';
  const [copied, setCopied] = useState(false);
  const [showEverything, setShowEverything] = useState(false);
  const copyManualCommand = () => {
    if (!manual) return;
    void navigator.clipboard
      ?.writeText(manual.command)
      .then(() => setCopied(true))
      .catch((err) => logRendererError('copy manual command failed', err));
  };
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

        {manual && phase === 'available' && (
          <div className="update-modal__manual">
            <p className="update-modal__hint">
              No Linux a atualização é manual. Feche o NexusIDE e rode no terminal:
            </p>
            <code className="update-modal__command">{manual.command}</code>
            <p className="update-modal__hint">
              O comando confere o SHA-256 e instala o pacote da sua distribuição.
              Suas contas, projetos e missões ficam como estão.
            </p>
          </div>
        )}
        {manual && (phase === 'uptodate' || phase === 'idle') && (
          <p className="update-modal__hint">
            No Linux a atualização é manual: quando sair uma versão nova, o
            Nexus avisa aqui e mostra o comando.
          </p>
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
          {phase === 'available' && !state.canInstall && !manual && (
            <span className="update-modal__hint">
              build de desenvolvimento — instale pelo app empacotado
            </span>
          )}
          {manual && phase === 'available' && (
            <>
              <button
                type="button"
                className="update-modal__btn update-modal__btn--primary"
                onClick={copyManualCommand}
              >
                {copied ? 'Comando copiado ✓' : 'Copiar comando'}
              </button>
              <button
                type="button"
                className="update-modal__btn"
                onClick={() => void window.nexus?.app?.openExternal(manual.downloadUrl)}
              >
                Abrir página de download
              </button>
            </>
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
                  const url = state.installerPlatform === 'linux'
                    ? 'https://nexuside.app/#download'
                    : `https://github.com/Hiper-nexus/nexus-ide/releases/tag/${tag}`;
                  void window.nexus?.app?.openExternal(url);
                }}
              >
                {state.installerPlatform === 'linux' ? 'Abrir página de downloads' : 'Baixar instalador (.dmg)'}
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
          <button
            type="button"
            className="update-modal__btn"
            disabled={busy}
            onClick={() => setShowEverything(true)}
            title="Atualiza as CLIs dos providers e este app numa passada só"
          >
            Atualizar tudo…
          </button>
        </div>
      </div>
      </div>
      {showEverything && (
        <UpdateEverythingDialog
          localVersion={available?.version ?? null}
          // NUNCA baixar em paralelo com os providers: o `install()` do
          // Squirrel não é só download — o `update-downloaded` abre diálogo
          // com quitAndInstall e reinicia no meio da passada. O app entra
          // só DEPOIS das CLIs (installLocal).
          canDownloadLocal={false}
          canInstallLocal={phase === 'ready' || Boolean(state.canInstall)}
          installLocal={
            window.nexus?.update
              ? async () => {
                  if (phase === 'ready') {
                    await window.nexus.update.restart();
                    return;
                  }
                  // Download + prepare; o diálogo nativo de "Reiniciar agora"
                  // só aparece quando as CLIs já terminaram.
                  await window.nexus.update.install();
                }
              : undefined
          }
          onClose={() => setShowEverything(false)}
        />
      )}
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
/**
 * Banner flutuante de notificação proativa de atualização.
 * Exibido quando há uma nova versão disponível ou pronta para reiniciar,
 * permitindo que o usuário veja e clique para atualizar imediatamente
 * sem precisar adivinhar se há updates.
 */
export function UpdateBannerNotice({
  state,
  onOpenModal,
}: {
  state: UpdateState;
  onOpenModal: () => void;
}) {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const version = state.available?.version ?? '';
  const isDismissed = Boolean(version && dismissedVersion === version);

  if (isDismissed) return null;
  if (
    state.phase !== 'available' &&
    state.phase !== 'ready' &&
    state.phase !== 'downloading'
  ) {
    return null;
  }

  const handleInstall = (e: React.MouseEvent) => {
    e.stopPropagation();
    void window.nexus?.update?.install?.();
  };

  const handleRestart = (e: React.MouseEvent) => {
    e.stopPropagation();
    void window.nexus?.update?.restart?.();
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (version) setDismissedVersion(version);
  };

  return (
    <div
      className={`update-banner update-banner--${state.phase}`}
      role="alert"
      aria-live="polite"
      onClick={onOpenModal}
    >
      <div className="update-banner__content">
        <span className="update-banner__badge" aria-hidden="true">
          <span className="update-banner__beacon" />
          {state.phase === 'ready' ? '🚀' : '✨'}
        </span>
        <div className="update-banner__text">
          <strong className="update-banner__title">
            {state.phase === 'ready'
              ? 'Atualização pronta para aplicar!'
              : state.phase === 'downloading'
                ? 'Baixando atualização…'
                : `Nova versão disponível: v${version}`}
          </strong>
          <span className="update-banner__desc">
            {state.phase === 'ready'
              ? 'Reinicie o NexusIDE para aplicar agora.'
              : state.phase === 'downloading'
                ? getDownloadLabel(state.downloadProgress)
                : state.manual
                  ? 'Clique para ver como atualizar.'
                  : 'Clique para atualizar agora ou ver notas.'}
          </span>
        </div>
      </div>

      <div
        className="update-banner__actions"
        onClick={(e) => e.stopPropagation()}
      >
        {state.phase === 'available' && state.canInstall && (
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={handleInstall}
          >
            Atualizar agora
          </button>
        )}
        {state.phase === 'ready' && (
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={handleRestart}
          >
            Reiniciar agora
          </button>
        )}
        <button
          type="button"
          className="update-banner__btn update-banner__btn--ghost"
          onClick={onOpenModal}
          title="Ver detalhes da versão"
        >
          Ver notas
        </button>
        <button
          type="button"
          className="update-banner__close"
          onClick={handleDismiss}
          aria-label="Lembrar mais tarde"
          title="Lembrar mais tarde"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Chip de atualização + banner proativo + painel, prontos para montar.
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
      <UpdateBannerNotice state={state} onOpenModal={() => setOpen(true)} />
      {open && <UpdateModal state={state} onClose={() => setOpen(false)} />}
    </>
  );
}
