import { useCallback, useEffect, useMemo, useState } from 'react';
import { CanvasView } from '../CanvasView';
import { PaneGrid } from '../PaneGrid';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { listPanes } from '../../lib/split-tree';
import { selectMissionTerminalPanes } from '../../lib/mission-terminal-panes';
import { missionLifecycleLabel } from '../../lib/mission-lifecycle-copy';
import { missionAwaitsOperatorReview } from '../../../shared/mission-recovery-policy';
import { PixelIcon } from '../PixelIcon';

export interface TerminalWorkspaceProps {
  /** Quando presente, a vista mostra só os panes desta missão. Hosts das outras ficam vivos. */
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
  // em missão já concluída/falha. Done SEM carimbo do humano é revisão, não
  // Pronto: senão o header dos Terminais declara encerrado o canal que ainda
  // precisa ficar aberto (F-108).
  const missionState = useOrchStore((state) =>
    missionId
      ? (state.missionSummaries.find((m) => m.id === missionId)?.state ??
        null)
      : null,
  );
  const awaitsReview = useOrchStore((state) => {
    if (!missionId) return false;
    const mission = state.missions.find((item) => item.id === missionId);
    return mission ? missionAwaitsOperatorReview(mission) : false;
  });
  const contextLabel = missionState
    ? `Missão · ${missionLifecycleLabel(missionState, false, undefined, awaitsReview)}`
    : 'Missão';
  const paneMissions = useOrchStore((state) => state.paneMissions);
  const layoutRoot = useLayoutStore((state) => state.root);
  // Panes que o operador abriu pelo "+ Pane" DENTRO desta vista. O filtro da
  // missão esconderia shells soltos e agentes sem missão — o pane nascia no
  // layout canônico mas nunca montava (sem PaneLeaf, sem PTY): "não abre, não
  // faz nada". Fixar o id aqui o mantém visível ao lado dos panes da missão.
  const [operatorPinIds, setOperatorPinIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setOperatorPinIds(new Set());
  }, [missionId]);
  const handlePaneCreated = useCallback((paneId: string) => {
    setOperatorPinIds((previous) =>
      previous.has(paneId) ? previous : new Set(previous).add(paneId),
    );
  }, []);
  const visiblePaneIds = useMemo(() => {
    if (!missionId) return undefined;
    const visible = selectMissionTerminalPanes(
      listPanes(layoutRoot),
      missionId,
      paneMissions,
    );
    const ids = new Set(visible.map((pane) => pane.id));
    for (const pinned of operatorPinIds) ids.add(pinned);
    return ids;
  }, [layoutRoot, missionId, paneMissions, operatorPinIds]);

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
        {viewKind === 'canvas' ? (
          <CanvasView
            visiblePaneIds={visiblePaneIds}
            onPaneCreated={handlePaneCreated}
          />
        ) : (
          <PaneGrid
            visiblePaneIds={visiblePaneIds}
            onPaneCreated={handlePaneCreated}
          />
        )}
      </div>
    </section>
  );
}
