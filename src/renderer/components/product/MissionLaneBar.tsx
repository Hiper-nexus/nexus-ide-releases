import { PixelIcon } from '../PixelIcon';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import { ALL_SCOPES_KEY } from '../../lib/pane-spaces';

/**
 * Rail de campos (missões / espaços / soltos) — o "rack" de canais do
 * workspace. Cada missão é um channel strip com o SEU orquestrador no crest,
 * para que dois campos lado a lado (A e B) nunca misturem identidade.
 *
 * Ancoragem visual: painel de rack de controle de missão — fundo near-black,
 * fio de 1px, acento magenta na faixa ativa. Sem gradiente nem sombra.
 */
export interface MissionLaneBarProps {
  readonly scopes: readonly PaneScopeEntry[];
  readonly activeScopeKey: string | null;
  readonly onFocusScope: (scopeKey: string) => void;
  readonly onStartSpaceRename?: (scope: PaneScopeEntry) => void;
  /** Pino A/B — cada campo pode ser fixado numa das duas metades. */
  readonly pinnedA: string | null;
  readonly pinnedB: string | null;
  readonly onTogglePin: (scopeKey: string) => void;
  readonly onSwitchAB: (side: 'a' | 'b') => void;
  readonly onNewMission: () => void;
}

const STATE_LABEL: Record<string, string> = {
  running: 'em curso',
  done: 'concluída',
  failed: 'falhou',
};

function pinSideFor(
  scopeKey: string,
  pinnedA: string | null,
  pinnedB: string | null,
): 'a' | 'b' | null {
  if (pinnedA === scopeKey) return 'a';
  if (pinnedB === scopeKey) return 'b';
  return null;
}

function OrchestratorCrest({
  title,
  live,
}: {
  readonly title: string | null;
  readonly live: boolean;
}) {
  if (!title) {
    return (
      <span className="mission-lane__crest mission-lane__crest--empty" title="Sem orquestrador neste campo">
        <PixelIcon name="orch" size={10} />
      </span>
    );
  }
  return (
    <span
      className={`mission-lane__crest${live ? ' mission-lane__crest--live' : ''}`}
      title={`Orquestrador: ${title}`}
    >
      <PixelIcon name="orch" size={10} />
      <span className="mission-lane__crest-tag">orq</span>
    </span>
  );
}

export function MissionLaneBar({
  scopes,
  activeScopeKey,
  onFocusScope,
  onStartSpaceRename,
  pinnedA,
  pinnedB,
  onTogglePin,
  onSwitchAB,
  onNewMission,
}: MissionLaneBarProps) {
  const hasMission = scopes.some((scope) => scope.kind === 'mission');
  const showAB = Boolean(pinnedA && pinnedB && pinnedA !== pinnedB);

  return (
    <header className="mission-lane-bar" role="toolbar" aria-label="Campos de trabalho">
      <div className="mission-lane-bar__rail">
        {scopes.map((scope) => {
          const active = activeScopeKey === scope.key;
          const pin = pinSideFor(scope.key, pinnedA, pinnedB);
          return (
            <div
              key={scope.key}
              className={`mission-lane terminal-workspace__filter-chip${
                active ? ' mission-lane--active terminal-workspace__filter-chip--active' : ''
              }`}
              data-scope-kind={scope.kind}
              data-pin={pin ?? undefined}
            >
              <button
                type="button"
                className="mission-lane__main"
                aria-pressed={active}
                onClick={() => onFocusScope(scope.key)}
                title={
                  scope.kind === 'space'
                    ? `${scope.title} — duplo clique para renomear`
                    : scope.title
                }
              >
                <span className="mission-lane__rule" aria-hidden="true" />
                <span className="mission-lane__body">
                  <span className="mission-lane__top">
                    {scope.kind === 'mission' && scope.state ? (
                      <span
                        className={`terminal-workspace__chip-dot terminal-workspace__chip-dot--${scope.state}`}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className="mission-lane__title terminal-workspace__filter-label"
                      onDoubleClick={
                        scope.kind === 'space' && onStartSpaceRename
                          ? (event) => {
                              event.stopPropagation();
                              onStartSpaceRename(scope);
                            }
                          : undefined
                      }
                    >
                      {scope.title}
                    </span>
                    <span className="terminal-workspace__filter-count terminal-workspace__chip-badge">
                      {scope.paneCount}
                    </span>
                  </span>
                  <span className="mission-lane__meta">
                    <OrchestratorCrest
                      title={scope.orchestrator?.title ?? null}
                      live={active}
                    />
                    <span className="mission-lane__meta-text">
                      {scope.kind === 'mission' && scope.state
                        ? (STATE_LABEL[scope.state] ?? scope.state)
                        : scope.kind === 'space'
                          ? 'espaço'
                          : 'soltos'}
                      {scope.orchestrator ? ` · ${scope.orchestrator.title}` : ''}
                    </span>
                  </span>
                </span>
              </button>
              <div className="mission-lane__actions">
                <button
                  type="button"
                  className={`mission-lane__pin${pin ? ` mission-lane__pin--${pin}` : ''}`}
                  aria-label={
                    pin
                      ? `Desafixar ${scope.title} do campo ${pin.toUpperCase()}`
                      : `Fixar ${scope.title} no campo A/B`
                  }
                  title={
                    pin
                      ? `Campo ${pin.toUpperCase()} — clique para desafixar`
                      : 'Fixar como campo A ou B'
                  }
                  onClick={() => onTogglePin(scope.key)}
                >
                  {pin ? pin.toUpperCase() : 'A/B'}
                </button>
                {scope.kind === 'space' && onStartSpaceRename ? (
                  <button
                    type="button"
                    className="mission-lane__pin"
                    aria-label={`Renomear ${scope.title}`}
                    title="Renomear espaço"
                    onClick={() => onStartSpaceRename(scope)}
                  >
                    <PixelIcon name="config" size={9} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className={`mission-lane mission-lane--all terminal-workspace__filter-chip${
            activeScopeKey === ALL_SCOPES_KEY
              ? ' mission-lane--active terminal-workspace__filter-chip--active'
              : ''
          }`}
          aria-pressed={activeScopeKey === ALL_SCOPES_KEY}
          onClick={() => onFocusScope(ALL_SCOPES_KEY)}
          title="Mostrar todos os campos"
        >
          <span className="mission-lane__rule" aria-hidden="true" />
          <span className="mission-lane__body">
            <span className="mission-lane__top">
              <span className="mission-lane__title terminal-workspace__filter-label">
                Todos
              </span>
            </span>
            <span className="mission-lane__meta-text">mescla os campos</span>
          </span>
        </button>
      </div>
      <div className="mission-lane-bar__actions">
        {showAB ? (
          <div className="mission-lane-bar__ab" role="group" aria-label="Alternar campo A ou B">
            <button
              type="button"
              className={`mission-lane-bar__ab-btn${
                activeScopeKey === pinnedA ? ' mission-lane-bar__ab-btn--active' : ''
              }`}
              aria-pressed={activeScopeKey === pinnedA}
              onClick={() => onSwitchAB('a')}
            >
              A
            </button>
            <button
              type="button"
              className={`mission-lane-bar__ab-btn${
                activeScopeKey === pinnedB ? ' mission-lane-bar__ab-btn--active' : ''
              }`}
              aria-pressed={activeScopeKey === pinnedB}
              onClick={() => onSwitchAB('b')}
            >
              B
            </button>
          </div>
        ) : hasMission ? (
          <span className="mission-lane-bar__hint" aria-hidden="true">
            fixe duas missões como A/B
          </span>
        ) : null}
        <button
          type="button"
          className="terminal-workspace__new-mission-btn"
          onClick={onNewMission}
          title="Iniciar uma nova missão"
        >
          <PixelIcon name="plus" size={10} />
          <span>Nova missão</span>
        </button>
      </div>
    </header>
  );
}
