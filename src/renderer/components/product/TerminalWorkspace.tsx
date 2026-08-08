import { CanvasView } from '../CanvasView';
import { PaneGrid } from '../PaneGrid';
import { useLayoutStore } from '../../state/layout-store';
import { PixelIcon } from '../PixelIcon';

export interface TerminalWorkspaceProps {
  /** Mission context is chrome only. The canonical layout always stays intact. */
  missionId?: string;
  onBackToBoard?: () => void;
  className?: string;
}

export function TerminalWorkspace({
  missionId,
  onBackToBoard,
  className = '',
}: TerminalWorkspaceProps) {
  const viewKind = useLayoutStore((state) => state.viewKind);
  const inMission = missionId !== undefined;

  return (
    <section
      className={`product-workspace terminal-workspace ${className}`.trim()}
      aria-label={inMission ? 'Terminais da missão' : 'Terminais'}
    >
      {inMission ? (
        <header className="product-workspace__header terminal-workspace__header">
          <div className="product-workspace__heading">
            <span className="product-workspace__context">Missão ativa</span>
            <h1>Terminais</h1>
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
