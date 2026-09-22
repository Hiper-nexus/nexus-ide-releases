import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  paneScopeKey,
  selectScopePanes,
  type PaneScopeEntry,
} from '../../lib/pane-spaces';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import { MissionLaneBar } from './MissionLaneBar';
import { missionLifecycleLabel } from '../../lib/mission-lifecycle-copy';
import { missionAwaitsOperatorReview } from '../../../shared/mission-recovery-policy';
import { PixelIcon } from '../PixelIcon';
import { EmptyState } from '../ActionCard';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { revealTerminalHostsAfterWorkspaceShow } from '../../terminal/terminal-host';

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
  const wasHiddenRef = useRef(hidden);
  useLayoutEffect(() => {
    const becameVisible = wasHiddenRef.current && !hidden;
    wasHiddenRef.current = hidden;
    if (becameVisible) revealTerminalHostsAfterWorkspaceShow();
  }, [hidden]);
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
  const pinnedA = usePaneScopeStore((state) => state.pinnedA);
  const pinnedB = usePaneScopeStore((state) => state.pinnedB);
  const togglePinScope = usePaneScopeStore((state) => state.togglePinScope);
  const switchAB = usePaneScopeStore((state) => state.switchAB);
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
  const focusedPaneId = useLayoutStore((state) => state.focusedPaneId);
  const renamePaneSpace = useLayoutStore((state) => state.renamePaneSpace);
  // Renomear a aba do espaço (duplo clique no chip): edição inline, mesmo
  // padrão do título do pane no PaneToolbar. Enter/blur gravam, Esc cancela.
  const [editingSpace, setEditingSpace] = useState<{
    key: string;
    draft: string;
  } | null>(null);
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

  // Pino cujo escopo sumiu (missão encerrada, espaço fechado) não vira um
  // botão A/B morto: só chega à barra o pino que ainda aponta para um campo.
  const livePinnedA = pinnedA && scopes.some((scope) => scope.key === pinnedA) ? pinnedA : null;
  const livePinnedB = pinnedB && scopes.some((scope) => scope.key === pinnedB) ? pinnedB : null;

  // Escopo desenhado agora. Dentro da missão é a própria missão, sempre. Na
  // vista global é a escolha do operador — e quando ela evapora (espaço
  // fechado, missão encerrada) cai no PRIMEIRO escopo com pane, nunca em
  // "mostrar tudo".
  const scopeExists =
    activeScopeKey === ALL_SCOPES_KEY ||
    scopes.some((scope) => scope.key === activeScopeKey);
  // O escopo do pane focado entra JÁ no cálculo, não só no efeito abaixo: sem
  // isto o primeiro quadro desenharia o escopo antigo e só então pularia — o
  // operador veria um piscar de painéis que não são dele.
  const focusedScopeKey = (() => {
    if (!focusedPaneId) return null;
    const focused = panes.find((pane) => pane.id === focusedPaneId);
    return focused ? paneScopeKey(focused, paneMissions) : null;
  })();
  const effectiveScopeKey = inMission
    ? missionScopeKey(missionId)
    : scopeExists && activeScopeKey
      ? activeScopeKey
      : (focusedScopeKey ?? scopes[0]?.key ?? null);

  /**
   * INVARIANTE: um painel que acabou de receber foco está NA TELA.
   *
   * Trinta e cinco lugares levam o operador para os Terminais depois de criar
   * ou escolher um painel — login de CLI, instalação de ferramenta, voz, ⌘K,
   * caixa de atenção, notificações de agente. Com a vista filtrando por escopo,
   * exigir que CADA um lembrasse de trocar a aba seria garantir que um
   * esquecesse: o pior caso é o pane de login, onde o app manda concluir o
   * OAuth num painel que não está desenhado.
   *
   * Então a regra mora aqui, uma vez: quando o pane FOCADO muda e ele está em
   * outro escopo, a aba acompanha. Só na MUDANÇA — clicar numa aba não é
   * puxado de volta pelo foco antigo.
   */
  const lastFollowedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (inMission || !focusedPaneId) return;
    if (lastFollowedFocusRef.current === focusedPaneId) return;
    lastFollowedFocusRef.current = focusedPaneId;
    const focused = panes.find((pane) => pane.id === focusedPaneId);
    if (!focused) return;
    const scopeOfFocused = paneScopeKey(focused, paneMissions);
    if (scopeOfFocused === effectiveScopeKey) return;
    focusScope(scopeOfFocused);
  }, [
    focusedPaneId,
    panes,
    paneMissions,
    effectiveScopeKey,
    focusScope,
    inMission,
  ]);

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

  const startSpaceRename = (scope: PaneScopeEntry) => {
    if (scope.kind !== 'space' || !scope.id) return;
    // O rascunho vem do carimbo real do pane, não do rótulo da aba — a aba
    // pode estar com o sufixo de desambiguação ("Título #2"), que não é nome.
    const raw =
      panes.find((pane) => pane.spaceId === scope.id && !pane.missionId)
        ?.spaceTitle ?? scope.title;
    setEditingSpace({ key: scope.key, draft: raw });
  };

  const commitSpaceRename = () => {
    const current = editingSpace;
    if (!current) return;
    const scope = scopes.find((entry) => entry.key === current.key);
    if (scope?.kind === 'space' && scope.id) {
      renamePaneSpace(scope.id, current.draft);
    }
    setEditingSpace(null);
  };

  const visiblePaneIds = useMemo(() => {
    if (!effectiveScopeKey) return undefined;
    if (effectiveScopeKey === ALL_SCOPES_KEY) return undefined;
    const visible = inMission
      ? selectMissionTerminalPanes(panes, missionId, paneMissions)
      : selectScopePanes(panes, effectiveScopeKey, paneMissions);
    const ids = new Set(visible.map((pane) => pane.id));
    for (const pinned of operatorPins[effectiveScopeKey] ?? []) ids.add(pinned);
    // Escopo único: NÃO filtrar. `undefined` faz o PaneGrid desenhar a árvore
    // CANÔNICA, que é sempre a mesma referência. Devolver um Set contendo todos
    // os panes parece equivalente e NÃO é: o grid reconstrói a árvore com
    // buildGridTree (split-tree.ts:77), que cunha ids novos a cada chamada, e
    // como este componente agora assina missionSummaries/paneMissions isso
    // recomputa a cada atualização de missão — remontando o mosaico por baixo e
    // levando a sessão de PTY junto. O gate de release pegou como
    // "dictation-hold-to-talk (write-refused-exited)" no app empacotado.
    if (ids.size === panes.length) return undefined;
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
        <MissionLaneBar
          scopes={scopes}
          activeScopeKey={effectiveScopeKey}
          onFocusScope={focusScope}
          onStartSpaceRename={startSpaceRename}
          pinnedA={livePinnedA}
          pinnedB={livePinnedB}
          onTogglePin={togglePinScope}
          onSwitchAB={switchAB}
          onNewMission={() => useProductNavigationStore.getState().openNewMission()}
        />
      ) : null}

      {/* Identidade do campo só com 2+ escopos: com um único campo ela disputava
          a linha de título com o nome do pane e o empurrava para fora da toolbar. */}
      {multiScope &&
        (() => {
          const activeScope = scopes.find(
            (scope) => scope.key === effectiveScopeKey,
          );
          if (!activeScope) return null;
          const pin =
            pinnedA === activeScope.key
              ? 'a'
              : pinnedB === activeScope.key
                ? 'b'
                : null;
          return (
            <div
              className="mission-field-header"
              data-scope-kind={activeScope.kind}
              role="status"
            >
              {pin ? (
                <span
                  className={`mission-field-header__pin mission-field-header__pin--${pin}`}
                >
                  {pin.toUpperCase()}
                </span>
              ) : null}
              <span className="mission-field-header__title">
                {editingSpace?.key === activeScope.key ? (
                  <input
                    className="terminal-workspace__chip-rename"
                    value={editingSpace.draft}
                    autoFocus
                    aria-label="Renomear espaço"
                    onChange={(event) =>
                      setEditingSpace({
                        key: activeScope.key,
                        draft: event.target.value,
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitSpaceRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setEditingSpace(null);
                      }
                    }}
                    onBlur={commitSpaceRename}
                  />
                ) : (
                  activeScope.title
                )}
              </span>
              {activeScope.kind === 'mission' && activeScope.state ? (
                <span
                  className={`terminal-workspace__chip-dot terminal-workspace__chip-dot--${activeScope.state}`}
                  aria-hidden="true"
                />
              ) : null}
              <span className="mission-field-header__meta">
                {activeScope.paneCount} painel{activeScope.paneCount === 1 ? '' : 's'}
              </span>
              {activeScope.orchestrator ? (
                <span
                  className="mission-field-header__orq"
                  title={`Orquestrador do campo: ${activeScope.orchestrator.title}`}
                >
                  <PixelIcon name="orch" size={11} />
                  <span className="mission-field-header__orq-tag">orq</span>
                  <span className="mission-field-header__orq-name">
                    {activeScope.orchestrator.title}
                  </span>
                </span>
              ) : (
                <span className="mission-field-header__orq mission-field-header__orq--empty">
                  sem orquestrador
                </span>
              )}
            </div>
          );
        })()}

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
