import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { PaneGrid } from '../PaneGrid';
import { MissionTerminalRecovery } from './MissionTerminalRecovery';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { listPanes } from '../../lib/split-tree';
import { selectMissionTerminalPanes } from '../../lib/mission-terminal-panes';
import {
  ALL_SCOPES_KEY,
  LOOSE_SCOPE_KEY,
  isDeadPaneState,
  listPaneScopes,
  looseHomeScopeKey,
  missionScopeKey,
  newPaneSpaceId,
  nextPaneSpaceTitle,
  paneScopeResolver,
  selectScopePanes,
  spaceScopeKey,
  type PaneScopeEntry,
} from '../../lib/pane-spaces';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import { useTabOrderStore } from '../../state/tab-order-store';
import { applyTabOrder, mergeTabOrder, moveTabKey } from '../../lib/tab-drag';
import { useSessionStateStore } from '../../state/session-state-store';
import { useToastStore } from '../../state/toast-store';
import {
  pickTabMissionLeader,
  startTabMissionFor,
  toastPromoted,
} from '../../lib/pane-mission-promote';
import { askConfirm, useConfirmStore } from '../../state/confirm-store';
import { workspaceTabIsClosable } from './WorkspaceTabs';
import { missionTeamOfScope } from './MissionTeamMapButton';
import { LiveWorkspaceTabs, MissionWorkingChip } from './TerminalLiveSignals';
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
 * surface there is indistinguishable from a broken PTY. Keep this surface free
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
  const sideScopeKey = usePaneScopeStore((state) => state.sideScopeKey);
  const focusScope = usePaneScopeStore((state) => state.focusScope);
  const showBeside = usePaneScopeStore((state) => state.showBeside);
  const closeBeside = usePaneScopeStore((state) => state.closeBeside);
  // O rótulo segue a projeção canônica da missão — "Missão ativa" fixo mentia
  // em missão já concluída/falha. Done SEM carimbo do humano é revisão, não
  // Pronto: senão o header dos Terminais declara encerrado o canal que ainda
  // precisa ficar aberto (F-108).
  const missionSummary = useOrchStore((state) =>
    missionId
      ? (state.missionSummaries.find((m) => m.id === missionId) ?? null)
      : null,
  );
  const missionSpaceId = useOrchStore((state) => missionId
    ? state.missions.find((item) => item.id === missionId)?.intentContract?.workspaceBinding?.spaceId
    : undefined);
  const awaitsReview = useOrchStore((state) => {
    if (!missionId) return false;
    const mission = state.missions.find((item) => item.id === missionId);
    return mission ? missionAwaitsOperatorReview(mission) : false;
  });
  const contextLabel = missionSummary
    ? `Missão · ${missionLifecycleLabel(missionSummary.state, false, missionSummary.stateReason?.code, awaitsReview)}`
    : 'Missão';
  const focusedPaneId = useLayoutStore((state) => state.focusedPaneId);
  const renamePaneSpace = useLayoutStore((state) => state.renamePaneSpace);
  // Renomear a aba (duplo clique, F2 ou menu): edição inline na própria aba.
  // Enter/blur gravam, Esc cancela.
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
  // Soltos moram no campo do coordenador local, quando ele existe.
  const looseHome = useMemo(
    () => looseHomeScopeKey(panes, paneMissions),
    [panes, paneMissions],
  );
  // A aba de cada pane, com a casa das missões hospedadas resolvida uma vez.
  const scopeOf = useMemo(
    () => paneScopeResolver(panes, paneMissions),
    [panes, paneMissions],
  );
  // WEB-13: a ordem escolhida pelo operador vale para a barra, o ⌘/Ctrl+Alt+←/→
  // e o "primeiro escopo" de fallback — uma ordem só na vista.
  const tabOrder = useTabOrderStore((state) => state.order);
  const scopes = useMemo(
    () =>
      applyTabOrder(
        listPaneScopes({
          panes,
          paneMissions,
          missions: missionSummaries.map((summary) => ({
            id: summary.id,
            title: summary.title,
            state: summary.state,
            ...(summary.stateReason?.code
              ? { stateReasonCode: summary.stateReason.code }
              : {}),
          })),
        }),
        tabOrder,
      ),
    [panes, paneMissions, missionSummaries, tabOrder],
  );
  const moveTab = useCallback(
    (scopeKey: string, toIndex: number) => {
      const store = useTabOrderStore.getState();
      const visible = moveTabKey(
        scopes.map((scope) => scope.key),
        scopeKey,
        toIndex,
      );
      store.setOrder(mergeTabOrder(store.order, visible));
    },
    [scopes],
  );

  // Escopo desenhado agora. Dentro da missão é a própria missão, sempre. Na
  // vista global é a escolha do operador — e quando ela evapora (espaço
  // fechado, missão encerrada) cai no PRIMEIRO escopo com pane, nunca em
  // "mostrar tudo".
  // "Focar os soltos" (Montar terminais, ⌘K) com coordenador local = focar o
  // campo dele: é lá que os soltos estão agora.
  const requestedScopeKey =
    activeScopeKey === LOOSE_SCOPE_KEY && looseHome ? looseHome : activeScopeKey;
  const scopeExists =
    requestedScopeKey === ALL_SCOPES_KEY ||
    scopes.some((scope) => scope.key === requestedScopeKey);
  // O escopo do pane focado entra JÁ no cálculo, não só no efeito abaixo: sem
  // isto o primeiro quadro desenharia o escopo antigo e só então pularia — o
  // operador veria um piscar de painéis que não são dele.
  const focusedScopeKey = (() => {
    if (!focusedPaneId) return null;
    const focused = panes.find((pane) => pane.id === focusedPaneId);
    return focused ? scopeOf(focused) : null;
  })();
  const effectiveScopeKey = inMission
    ? missionSpaceId ? spaceScopeKey(missionSpaceId) : missionScopeKey(missionId)
    : scopeExists && requestedScopeKey
      ? requestedScopeKey
      : (focusedScopeKey ?? scopes[0]?.key ?? null);
  const overview = !inMission && effectiveScopeKey === ALL_SCOPES_KEY;

  // Aba ao lado: só fora da visão geral, só se ainda existe e não é a própria
  // aba ativa. Qualquer outra coisa é uma aba só.
  const liveSideKey =
    !inMission &&
    !overview &&
    sideScopeKey &&
    sideScopeKey !== effectiveScopeKey &&
    scopes.some((scope) => scope.key === sideScopeKey)
      ? sideScopeKey
      : null;

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
   * puxado de volta pelo foco antigo. Pane da aba aberta ao lado já está na
   * tela: não troca aba nenhuma.
   */
  const lastFollowedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (inMission || !focusedPaneId) return;
    if (lastFollowedFocusRef.current === focusedPaneId) return;
    lastFollowedFocusRef.current = focusedPaneId;
    // Na visão geral todo pane já está na tela: o foco não tira o operador dela.
    if (overview) return;
    const focused = panes.find((pane) => pane.id === focusedPaneId);
    if (!focused) return;
    const scopeOfFocused = scopeOf(focused);
    if (scopeOfFocused === effectiveScopeKey || scopeOfFocused === liveSideKey) {
      return;
    }
    focusScope(scopeOfFocused);
  }, [
    focusedPaneId,
    panes,
    scopeOf,
    effectiveScopeKey,
    liveSideKey,
    focusScope,
    inMission,
    overview,
  ]);

  const pinPaneToScope = useCallback(
    (scopeKey: string | null, paneId: string) => {
      if (!scopeKey) return;
      // Pane aberto pelo "+ Pane" DENTRO de um espaço pertence àquele espaço.
      // O pin abaixo só o mantém na tela nesta sessão; o carimbo é o que faz
      // ele voltar na aba certa depois do restart.
      const scope = scopes.find((entry) => entry.key === scopeKey);
      if (scope?.kind === 'space' && scope.id) {
        useLayoutStore.getState().assignPaneSpace(paneId, scope.id, scope.title);
      } else if (scope?.kind === 'mission') {
        // F-231 — "Nesta aba (solto)" numa aba de missão: a aba não é um
        // espaço, então o carimbo persistente é o `homeScopeKey` — sem ele o
        // pane solto ia para "Terminais" no próximo restart.
        useLayoutStore.getState().assignPaneHomeScopeKey(paneId, scopeKey);
      }
      setOperatorPins((previous) => {
        const current = previous[scopeKey];
        if (current?.has(paneId)) return previous;
        const next = new Set(current ?? []);
        next.add(paneId);
        return { ...previous, [scopeKey]: next };
      });
    },
    [scopes],
  );
  const handlePaneCreated = useCallback(
    (paneId: string) => pinPaneToScope(effectiveScopeKey, paneId),
    [pinPaneToScope, effectiveScopeKey],
  );
  const handleSidePaneCreated = useCallback(
    (paneId: string) => pinPaneToScope(liveSideKey, paneId),
    [pinPaneToScope, liveSideKey],
  );

  // F-231 — "+ Pane" numa aba que hospeda missão viva: o picker ganha o passo
  // de destino ("Nesta missão" / "Nesta aba (solto)" / "Nova aba"). O Main é
  // quem valida de verdade; aqui só se escolhe a missão EXIBIDA nesta aba.
  const orchMissions = useOrchStore((state) => state.missions);
  const missionDestinationFor = useCallback(
    (scopeKey: string | null) => {
      if (!scopeKey) return null;
      const scope = scopes.find((entry) => entry.key === scopeKey);
      const hosted = scope?.missions.find((mission) => {
        const status =
          orchMissions.find((item) => item.id === mission.id)?.status ??
          mission.state;
        return status === 'running' || status === 'pending';
      });
      return hosted ? { missionId: hosted.id, title: hosted.title } : null;
    },
    [scopes, orchMissions],
  );
  const missionDestination = missionDestinationFor(effectiveScopeKey);
  const sideMissionDestination = missionDestinationFor(liveSideKey);

  // "+" da barra: o pane escolhido nasce numa aba NOVA, e o operador vai com ele.
  const handleTabPaneCreated = useCallback((paneId: string) => {
    const layout = useLayoutStore.getState();
    const others = listPanes(layout.root).filter((pane) => pane.id !== paneId);
    const spaceId = newPaneSpaceId();
    layout.assignPaneSpace(paneId, spaceId, nextPaneSpaceTitle(others), true);
    usePaneScopeStore.getState().focusScope(spaceScopeKey(spaceId));
    layout.focus(paneId);
  }, []);

  // "Criar missão desta aba": quem lidera é o orquestrador da aba, senão a IA
  // focada nela, senão a primeira — o mesmo caminho de "Tornar orquestrador".
  const startTabMission = useCallback(async (scope: PaneScopeEntry) => {
    const agents = selectScopePanes(
      listPanes(useLayoutStore.getState().root),
      scope.key,
      useOrchStore.getState().paneMissions,
    ).filter((pane) => pane.kind === 'cli-agent');
    // F-373: só pane com sessão VIVA pode liderar — o Maestro morto da missão
    // dormindo ainda é `orchestrator` no escopo e coroá-lo volta pane_unavailable.
    const leader = pickTabMissionLeader(agents, {
      orchestratorPaneId: scope.orchestrator?.paneId,
      focusedPaneId: useLayoutStore.getState().focusedPaneId,
      paneStates: useSessionStateStore.getState().paneStates,
    });
    if (!leader) {
      useToastStore.getState().push(
        'info',
        'Abra uma IA nesta aba',
        'A missão da aba é liderada por um painel de IA. Use o + Pane e tente de novo.',
      );
      return;
    }
    const missionId = await startTabMissionFor({
      paneId: leader.id,
      paneTitle: leader.title,
    });
    if (!missionId) return;
    toastPromoted(useOrchStore.getState().missions.find((m) => m.id === missionId)?.title, missionId);
  }, []);

  const closeTab = useCallback(
    async (scope: PaneScopeEntry) => {
      const members = selectScopePanes(
        listPanes(useLayoutStore.getState().root),
        scope.key,
        useOrchStore.getState().paneMissions,
      ).filter((pane) => !pane.isStructuralPlaceholder);
      if (members.length === 0) return;
      const paneStates = useSessionStateStore.getState().paneStates;
      const retired = members.every(
        (pane) => isDeadPaneState(paneStates.get(pane.id)),
      );
      if (!retired && !workspaceTabIsClosable(scope)) return;
      const confirmed = await askConfirm({
        title: `Fechar a aba “${scope.title}”?`,
        body:
          members.length === 1
            ? 'O painel desta aba será encerrado, com o que estiver rodando nele.'
            : `Os ${members.length} painéis desta aba serão encerrados, com o que estiver rodando neles.`,
        confirmLabel: 'Fechar aba',
        danger: true,
      });
      if (!confirmed) return;
      const layout = useLayoutStore.getState();
      for (const pane of members) layout.close(pane.id, 'tab-close');
      if (usePaneScopeStore.getState().sideScopeKey === scope.key) closeBeside();
    },
    [closeBeside],
  );

  const startSpaceRename = (scope: PaneScopeEntry) => {
    if (scope.kind === 'mission') return;
    // O rascunho vem do carimbo real do pane, não do rótulo da aba — a aba
    // pode estar com o sufixo de desambiguação ("Título #2"), que não é nome.
    const raw =
      scope.kind === 'space'
        ? (panes.find((pane) => pane.spaceId === scope.id && pane.spaceTitle)
            ?.spaceTitle ?? scope.title)
        : scope.title;
    setEditingSpace({ key: scope.key, draft: raw });
  };

  const commitSpaceRename = () => {
    const current = editingSpace;
    if (!current) return;
    setEditingSpace(null);
    const scope = scopes.find((entry) => entry.key === current.key);
    if (!scope) return;
    if (scope.kind === 'space' && scope.id) {
      renamePaneSpace(scope.id, current.draft);
      return;
    }
    if (scope.kind === 'loose') {
      // "Terminais" não tinha espaço: dar nome é criar um, com os panes dela.
      const clean = current.draft.trim();
      if (!clean || clean === scope.title) return;
      const spaceId = newPaneSpaceId();
      if (useLayoutStore.getState().nameLooseSpace(spaceId, clean)) {
        focusScope(spaceScopeKey(spaceId));
      }
    }
  };

  const visibleIdsFor = useCallback(
    (scopeKey: string): Set<string> => {
      const visible =
        inMission && scopeKey === missionScopeKey(missionId)
          ? selectMissionTerminalPanes(panes, missionId, paneMissions)
          : selectScopePanes(panes, scopeKey, paneMissions);
      const ids = new Set(visible.map((pane) => pane.id));
      for (const pinned of operatorPins[scopeKey] ?? []) ids.add(pinned);
      return ids;
    },
    [panes, paneMissions, operatorPins, inMission, missionId],
  );

  const visiblePaneIds = useMemo(() => {
    if (!effectiveScopeKey) return undefined;
    if (effectiveScopeKey === ALL_SCOPES_KEY) return undefined;
    const ids = visibleIdsFor(effectiveScopeKey);
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
  }, [effectiveScopeKey, visibleIdsFor, panes.length]);

  const sidePaneIds = useMemo(
    () => (liveSideKey ? visibleIdsFor(liveSideKey) : undefined),
    [liveSideKey, visibleIdsFor],
  );

  /**
   * INVARIANTE (a volta da de cima): o pane focado está NA TELA.
   *
   * Trocar de campo pela barra mudava só o que é desenhado; o foco ficava no
   * pane do campo anterior, agora escondido. Ditado, Jarvis e anexos entregam
   * no pane focado — o texto dito olhando para o campo B ia parar no agente do
   * campo A (operador, 23/09: pedido de outro projeto caiu no Claude do
   * saasbarbearia). Quando o campo desenhado muda e o foco não está nele, o
   * foco vai para o orquestrador do campo, senão para o primeiro pane dele.
   */
  // Qual lado mudou nesta passada. Só o CAMPO mudou (clique na aba) → o
  // foco segue o campo. O FOCO mudou (login, ⌘K, notificação, voz focando um
  // pane de outro campo) → quem manda é o efeito de cima, que leva o campo
  // até o pane; aqui `visiblePaneIds` ainda é do campo antigo e devolver o
  // foco ao orquestrador dele mandaria o OAuth/ditado para o agente errado.
  const previousScopeRef = useRef(effectiveScopeKey);
  const previousFocusRef = useRef(focusedPaneId);
  useEffect(() => {
    const scopeChanged = previousScopeRef.current !== effectiveScopeKey;
    const focusChanged = previousFocusRef.current !== focusedPaneId;
    previousScopeRef.current = effectiveScopeKey;
    previousFocusRef.current = focusedPaneId;
    if (!scopeChanged || focusChanged) return;
    if (!visiblePaneIds) return; // a árvore inteira está na tela
    if (focusedPaneId && visiblePaneIds.has(focusedPaneId)) return;
    const scope = scopes.find((entry) => entry.key === effectiveScopeKey);
    const orchestratorId = scope?.orchestrator?.paneId;
    const target =
      orchestratorId && visiblePaneIds.has(orchestratorId)
        ? orchestratorId
        : panes.find((pane) => visiblePaneIds.has(pane.id))?.id;
    if (!target) return;
    // O efeito de cima vai ver o foco já DENTRO do campo desenhado: sem volta.
    lastFollowedFocusRef.current = target;
    useLayoutStore.getState().focus(target);
  }, [visiblePaneIds, focusedPaneId, scopes, effectiveScopeKey, panes]);

  // ⌘/Ctrl+Alt+→/← troca de aba. Capture-phase pelo mesmo motivo do
  // Ctrl+Tab do App: a tecla precisa chegar ANTES do xterm escrever no PTY.
  const cycleRef = useRef({ scopes, effectiveScopeKey, overview });
  cycleRef.current = { scopes, effectiveScopeKey, overview };
  useEffect(() => {
    if (hidden || inMission) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) {
        return;
      }
      if (useConfirmStore.getState().pending) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      // Campo de texto do app é edição; o textarea do xterm é o terminal.
      if (
        target?.closest('input, textarea, [contenteditable="true"]') &&
        !target.closest('.xterm')
      ) {
        return;
      }
      const current = cycleRef.current;
      if (current.scopes.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const index = current.overview
        ? -1
        : current.scopes.findIndex((scope) => scope.key === current.effectiveScopeKey);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next =
        current.scopes[
          (index + step + current.scopes.length) % current.scopes.length
        ] ?? current.scopes[0]!;
      usePaneScopeStore.getState().focusScope(next.key);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [hidden, inMission]);

  const sideScope = liveSideKey
    ? scopes.find((scope) => scope.key === liveSideKey)
    : undefined;
  const activeScope =
    effectiveScopeKey && !overview
      ? scopes.find((scope) => scope.key === effectiveScopeKey)
      : undefined;
  // Cabeçalho da missão: o chip conta quem trabalha NOS terminais que ele
  // desenha (ver MissionWorkingChip). O estado vivo é assinado lá, não aqui —
  // este componente carrega o grid dos xterms e não re-renderiza a cada turno.
  const missionPaneIds = useMemo(
    () =>
      inMission && effectiveScopeKey ? visibleIdsFor(effectiveScopeKey) : null,
    [inMission, effectiveScopeKey, visibleIdsFor],
  );

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
            <MissionWorkingChip panes={panes} visibleIds={missionPaneIds} />
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
      ) : (
        <LiveWorkspaceTabs
          panes={panes}
          scopeOf={scopeOf}
          scopes={scopes}
          activeScopeKey={overview ? null : effectiveScopeKey}
          sideScopeKey={liveSideKey}
          overview={overview}
          editing={editingSpace}
          onFocusScope={focusScope}
          onToggleOverview={() =>
            focusScope(
              overview
                ? (focusedScopeKey ?? scopes[0]?.key ?? ALL_SCOPES_KEY)
                : ALL_SCOPES_KEY,
            )
          }
          onToggleBeside={(scopeKey) => showBeside(scopeKey, effectiveScopeKey)}
          onCloseBeside={closeBeside}
          onStartRename={startSpaceRename}
          onRenameDraft={(draft) =>
            setEditingSpace((current) => (current ? { ...current, draft } : current))
          }
          onCommitRename={commitSpaceRename}
          onCancelRename={() => setEditingSpace(null)}
          onCloseTab={(scope) => void closeTab(scope)}
          onTabPaneCreated={handleTabPaneCreated}
          onNewMission={() => useProductNavigationStore.getState().openNewMission()}
          onStartTabMission={(scope) => void startTabMission(scope)}
          onMoveTab={moveTab}
          teamMap={activeScope ? missionTeamOfScope(activeScope, panes, paneMissions) : null}
          onOpenTeamMap={(id) => useProductNavigationStore.getState().openMission(id)}
        />
      )}

      <div className="terminal-workspace__surface">
        {inMission && visiblePaneIds?.size === 0 ? (
          <PaneGrid
            visiblePaneIds={visiblePaneIds}
            emptyState={
              <MissionTerminalRecovery key={missionId} missionId={missionId} />
            }
          />
        ) : sideScope && sidePaneIds && activeScope ? (
          <div className="terminal-workspace__split">
            <Group orientation="horizontal" className="panel-group">
              <Panel className="panel" defaultSize="50%" minSize="24%">
                <div className="terminal-workspace__half" data-primary="">
                  <div className="terminal-workspace__half-head">
                    <span className="terminal-workspace__half-title">
                      {activeScope.title}
                    </span>
                  </div>
                  <div className="terminal-workspace__half-body">
                    <PaneGrid
                      visiblePaneIds={visiblePaneIds ?? visibleIdsFor(activeScope.key)}
                      onPaneCreated={handlePaneCreated}
                      missionDestination={missionDestination ?? undefined}
                      onPaneCreatedLoose={handlePaneCreated}
                      onPaneCreatedInNewTab={handleTabPaneCreated}
                    />
                  </div>
                </div>
              </Panel>
              <Separator className="resize-handle resize-handle--horizontal" />
              <Panel className="panel" defaultSize="50%" minSize="24%">
                <div className="terminal-workspace__half">
                  <div className="terminal-workspace__half-head">
                    <span className="terminal-workspace__half-title">
                      {sideScope.title}
                    </span>
                    <button
                      type="button"
                      className="terminal-workspace__half-close"
                      aria-label={`Fechar a divisão com ${sideScope.title}`}
                      title="Fechar a divisão"
                      onClick={closeBeside}
                    >
                      <PixelIcon name="close" size={9} />
                    </button>
                  </div>
                  <div className="terminal-workspace__half-body">
                    <PaneGrid
                      visiblePaneIds={sidePaneIds}
                      onPaneCreated={handleSidePaneCreated}
                      primary={false}
                      missionDestination={sideMissionDestination ?? undefined}
                      onPaneCreatedLoose={handleSidePaneCreated}
                      onPaneCreatedInNewTab={handleTabPaneCreated}
                    />
                  </div>
                </div>
              </Panel>
            </Group>
          </div>
        ) : (
          <PaneGrid
            visiblePaneIds={visiblePaneIds}
            onPaneCreated={handlePaneCreated}
            missionDestination={missionDestination ?? undefined}
            onPaneCreatedLoose={handlePaneCreated}
            onPaneCreatedInNewTab={handleTabPaneCreated}
          />
        )}
      </div>
    </section>
  );
}
