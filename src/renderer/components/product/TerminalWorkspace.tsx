import { CanvasView } from '../CanvasView';
import { PaneGrid } from '../PaneGrid';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { MISSION_LIFECYCLE_LABELS } from '../../lib/mission-lifecycle-copy';
import { PixelIcon } from '../PixelIcon';

export interface TerminalWorkspaceProps {
  /** Mission context is chrome only. The canonical layout always stays intact. */
  missionId?: string;
  onBackToBoard?: () => void;
  /** Keeps pane/session hosts mounted while removing the surface from navigation. */
  hidden?: boolean;
  className?: string;
}

export function TerminalWorkspace({
  missionId,
  onBackToBoard,
  hidden = false,
  className = '',
}: TerminalWorkspaceProps) {
  const viewKind = useLayoutStore((state) => state.viewKind);
  const inMission = missionId !== undefined;
  // O rótulo segue a projeção canônica da missão — "Missão ativa" fixo mentia
  // em missão já concluída/falha.
  const missionState = useOrchStore((state) =>
    missionId
      ? (state.missionSummaries.find((m) => m.id === missionId)?.state ??
        null)
      : null,
  );
  const contextLabel = missionState
    ? `Missão · ${MISSION_LIFECYCLE_LABELS[missionState]}`
    : 'Missão';

  return (
    <section
      className={`product-workspace terminal-workspace ${className}`.trim()}
      hidden={hidden}
      aria-hidden={hidden ? true : undefined}
      aria-label={inMission ? 'Terminais da missão' : 'Terminais'}
    >
      {inMission ? (
        <header className="product-workspace__header terminal-workspace__header">
          <div className="product-workspace__identity">
            <span className="product-workspace__badge" aria-hidden="true">
              <PixelIcon name="terminal" size={16} />
            </span>
            <div className="product-workspace__heading">
              <span className="product-workspace__context">{contextLabel}</span>
              <h1>Terminais</h1>
            </div>
          </div>
          {onBackToBoard ? (
            <button
              type="button"
              className="product-workspace__back"
              onClick={onBackToBoard}
              aria-label="Voltar ao Quadro da missão"
              title={missionId}
            >
              <PixelIcon name="arrow-left" size={12} />
              <span>Voltar ao Quadro</span>
            </button>
          ) : null}
        </header>
      ) : null}

      <div className="terminal-workspace__surface">
        {viewKind === 'canvas' ? <CanvasView /> : <PaneGrid />}
      </div>
    </section>
  );
}
