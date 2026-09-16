import { useCallback, useMemo, useState } from 'react';
import { CanvasView } from '../CanvasView';
import { PaneGrid } from '../PaneGrid';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { listPanes } from '../../lib/split-tree';
import { selectMissionTerminalPanes } from '../../lib/mission-terminal-panes';
import {
  ALL_SCOPES_KEY,
  listPaneScopes,
  missionScopeKey,
  selectScopePanes,
} from '../../lib/pane-spaces';
import { usePaneScopeStore } from '../../state/pane-scope-store';
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
  // F-560: a vista global passou a filtrar por ESCOPO (missão | espaço do
  // operador | soltos), não só por missão. O filtro antigo desligava inteiro
  // quando nenhuma missão qualificava — e era exatamente aí que o assistente
  // "Montar meus terminais" aterrissava, despejando os painéis novos no mesmo
  // mosaico da missão já aberta.
  // A escolha NÃO é zerada ao montar nem ao trocar de missão. Quem abre um
  // espaço ("Montar meus terminais") escolhe o escopo ANTES de navegar; um
  // reset no mount apagaria justamente essa escolha e devolveria o operador ao
  // mosaico da missão anterior. A validação contra `scopes` abaixo já cobre o
  // escopo que deixou de existir.
  const activeScopeKey = usePaneScopeStore((state) => state.activeScopeKey);
  const focusScope = usePaneScopeStore((state) => state.focusScope);
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
  const missionSummaries = useOrchStore((state) => state.missionSummaries);
  const layoutRoot = useLayoutStore((state) => state.root);
  // Panes que o operador abriu pelo "+ Pane" DENTRO desta vista. O filtro da
  // missão esconderia shells soltos e agentes sem missão — o pane nascia no
  // layout canônico mas nunca montava (sem PaneLeaf, sem PTY): "não abre, não
  // faz nada". Fixar o id aqui o mantém visível ao lado dos panes da missão.
  //
  // O pin é POR ESCOPO. Guardar um Set solto vazava: os pins da missão A já
  // entravam no conjunto visível da missão B no mesmo render, antes de o efeito
  // de limpeza rodar (F-560).
  const [operatorPins, setOperatorPins] = useState<
    Readonly<Record<string, ReadonlySet<string>>>
  >(() => ({}));
  const panes = useMemo(() => listPanes(layoutRoot), [layoutRoot]);
  const scopes = useMemo(
    () =>
      listPaneScopes({
        panes,
        paneMissions,
        missions: missionSummaries.map((summary) => ({
          id: summary.id,
          title: summary.title,
          state: summary.state,
        })),
      }),
    [panes, paneMissions, missionSummaries],
  );

  // Escopo desenhado agora. Dentro da missão é a própria missão, sempre. Na
  // vista global é a escolha do operador — e quando ela evapora (espaço
  // fechado, missão encerrada) cai no PRIMEIRO escopo com pane, nunca em
  // "mostrar tudo".
  const scopeExists =
    activeScopeKey === ALL_SCOPES_KEY ||
    scopes.some((scope) => scope.key === activeScopeKey);
  const effectiveScopeKey = inMission
    ? missionScopeKey(missionId)
    : (scopeExists && activeScopeKey ? activeScopeKey : scopes[0]?.key ?? null);

  const handlePaneCreated = useCallback(
    (paneId: string) => {
      const scopeKey = effectiveScopeKey;
      if (!scopeKey) return;
      // Pane aberto pelo "+ Pane" DENTRO de um espaço pertence àquele espaço.
      // O pin abaixo só o mantém na tela nesta sessão; o carimbo é o que faz
      // ele voltar na aba certa depois do restart.
      const scope = scopes.find((entry) => entry.key === scopeKey);
      if (scope?.kind === 'space' && scope.id) {
        useLayoutStore.getState().assignPaneSpace(paneId, scope.id, scope.title);
      }
      setOperatorPins((previous) => {
        const current = previous[scopeKey];
        if (current?.has(paneId)) return previous;
        const next = new Set(current ?? []);
        next.add(paneId);
        return { ...previous, [scopeKey]: next };
      });
    },
    [effectiveScopeKey, scopes],
  );

  const multiScope = !inMission && scopes.length >= 2;

  const visiblePaneIds = useMemo(() => {
    if (!effectiveScopeKey) return undefined;
    if (effectiveScopeKey === ALL_SCOPES_KEY) return undefined;
    const visible = inMission
      ? selectMissionTerminalPanes(panes, missionId, paneMissions)
      : selectScopePanes(panes, effectiveScopeKey, paneMissions);
    const ids = new Set(visible.map((pane) => pane.id));
    for (const pinned of operatorPins[effectiveScopeKey] ?? []) ids.add(pinned);
    return ids;
  }, [
    panes,
    effectiveScopeKey,
    paneMissions,
    operatorPins,
    inMission,
    missionId,
  ]);

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

      {multiScope ? (
        <header
          className="terminal-workspace__filterbar"
          role="toolbar"
          aria-label="Filtrar terminais por missão ou espaço"
        >
          <span className="terminal-workspace__filterbar-label">Abas:</span>
          {scopes.map((scope) => (
            <button
              key={scope.key}
              type="button"
              className={`terminal-workspace__filter-chip${
                effectiveScopeKey === scope.key
                  ? ' terminal-workspace__filter-chip--active'
                  : ''
              }`}
              aria-pressed={effectiveScopeKey === scope.key}
              onClick={() => focusScope(scope.key)}
              title={scope.title}
              data-scope-kind={scope.kind}
            >
              <span className="terminal-workspace__filter-label">
                {scope.title}
              </span>
              <span className="terminal-workspace__filter-count">
                {scope.paneCount}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={`terminal-workspace__filter-chip${
              effectiveScopeKey === ALL_SCOPES_KEY
                ? ' terminal-workspace__filter-chip--active'
                : ''
            }`}
            aria-pressed={effectiveScopeKey === ALL_SCOPES_KEY}
            onClick={() => focusScope(ALL_SCOPES_KEY)}
          >
            <span className="terminal-workspace__filter-label">Todos</span>
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
