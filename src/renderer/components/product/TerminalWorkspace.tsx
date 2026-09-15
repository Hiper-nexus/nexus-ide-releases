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
import { EmptyState } from '../ActionCard';

export interface TerminalWorkspaceProps {
  /** Quando presente, a vista mostra só os panes desta missão. Hosts das outras ficam vivos. */
  missionId?: string;
  onBackToBoard?: () => void;
  /** Keeps pane/session hosts mounted while removing the surface from navigation. */
  hidden?: boolean;
  className?: string;
}

/**
 * Terminal destination without an active project. The app shell still lets
 * the operator click "Terminais" before choosing a folder; returning a blank
 * canvas there is indistinguishable from a broken PTY. Keep this surface free
 * of PaneLeaf/PTY work until the workspace scope exists, and give the operator
 * one explicit recovery action instead.
 */
export function TerminalWorkspaceEmpty({
  onOpenWorkspace,
}: {
  readonly onOpenWorkspace: () => void;
}) {
  return (
    <section
      className="product-workspace product-page terminal-workspace terminal-workspace--empty"
      data-product-destination="terminal"
      aria-label="Terminais"
    >
      <header className="product-workspace__header terminal-workspace__header">
        <div className="product-workspace__identity">
          <span className="product-workspace__badge" aria-hidden="true">
            <PixelIcon name="terminal" size={16} />
          </span>
          <div className="product-workspace__heading">
            <span className="product-workspace__context">Seu espaço</span>
            <h1>Terminais</h1>
          </div>
        </div>
      </header>
      <div className="terminal-workspace__empty-body">
        <EmptyState
          icon="files"
          title="Escolha uma pasta para abrir os terminais"
          body={
            <p>
              O Nexus precisa de um projeto ativo para criar o terminal e
              manter o acesso protegido aos seus arquivos.
            </p>
          }
          action={
            <button
              type="button"
              className="project-overview__goal-submit"
              onClick={onOpenWorkspace}
            >
              Escolher pasta
            </button>
          }
        />
      </div>
    </section>
  );
}

export function TerminalWorkspace({
  missionId,
  onBackToBoard,
  hidden = false,
  className = '',
}: TerminalWorkspaceProps) {
  const viewKind = useLayoutStore((state) => state.viewKind);
  const inMission = missionId !== undefined;
  // F-527: filtro de missão na vista GLOBAL. Com duas ou mais missões vivendo
  // na mesma árvore de panes, a vista "Todas" misturava tudo — a "bagunça na
  // tela". O foco abre na missão mais recente e "Todas as missões" volta a
  // mostrar o grid inteiro em um clique.
  const [globalFocusMissionId, setGlobalFocusMissionId] = useState<
    string | null
  >(null);
  useEffect(() => {
    setGlobalFocusMissionId(null);
  }, [missionId]);
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
  const panes = useMemo(() => listPanes(layoutRoot), [layoutRoot]);
  // Missões ativas que realmente têm panes nesta árvore (a base dos chips).
  const missionsWithPanes = useMemo(() => {
    const byId = new Map<string, { id: string; title: string; state: string }>();
    for (const pane of panes) {
      const boundId = pane.missionId ?? paneMissions[pane.id];
      if (!boundId || byId.has(boundId)) continue;
      const summary = useOrchStore
        .getState()
        .missionSummaries.find((m) => m.id === boundId);
      if (!summary) continue;
      const state = summary.state;
      const live =
        state === 'running' ||
        state === 'starting' ||
        state === 'recovering' ||
        state === 'review_ready' ||
        state === 'blocked_user' ||
        state === 'blocked_technical';
      if (!live) continue;
      byId.set(boundId, { id: boundId, title: summary.title, state });
    }
    return [...byId.values()];
  }, [panes, paneMissions]);

  const multiMission = !inMission && missionsWithPanes.length >= 2;
  const VIEW_ALL = '__all__';
  const globalFocus =
    globalFocusMissionId === VIEW_ALL
      ? null
      : (globalFocusMissionId ?? missionsWithPanes[0]?.id ?? null);
  const effectiveMissionId = inMission ? missionId : globalFocus;

  const visiblePaneIds = useMemo(() => {
    if (!effectiveMissionId) return undefined;
    const visible = selectMissionTerminalPanes(
      panes,
      effectiveMissionId,
      paneMissions,
    );
    const ids = new Set(visible.map((pane) => pane.id));
    for (const pinned of operatorPinIds) ids.add(pinned);
    // Em vista global (!inMission), panes desvinculados de missão (shells avulsos,
    // agentes soltos montados via grid/launcher) NUNCA podem sumir da grade
    // por causa de um filtro automático de missão anterior!
    if (!inMission) {
      for (const pane of panes) {
        const boundId = pane.missionId ?? paneMissions[pane.id];
        if (!boundId) ids.add(pane.id);
      }
    }
    return ids;
  }, [panes, effectiveMissionId, paneMissions, operatorPinIds, inMission]);

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

      {multiMission ? (
        <header className="terminal-workspace__filterbar" role="toolbar" aria-label="Filtrar terminais por missão">
          <span className="terminal-workspace__filterbar-label">Missões:</span>
          {missionsWithPanes.map((mission) => (
            <button
              key={mission.id}
              type="button"
              className={`terminal-workspace__filter-chip${
                globalFocus === mission.id
                  ? ' terminal-workspace__filter-chip--active'
                  : ''
              }`}
              aria-pressed={globalFocus === mission.id}
              onClick={() => setGlobalFocusMissionId(mission.id)}
              title={mission.title}
            >
              {mission.title || 'Missão sem título'}
            </button>
          ))}
          <button
            type="button"
            className={`terminal-workspace__filter-chip${
              globalFocus === null
                ? ' terminal-workspace__filter-chip--active'
                : ''
            }`}
            aria-pressed={globalFocus === null}
            onClick={() => setGlobalFocusMissionId(VIEW_ALL)}
          >
            Todas as missões
          </button>
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
