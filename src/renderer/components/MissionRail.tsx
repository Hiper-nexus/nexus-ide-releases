import { useEffect, useMemo, useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import type { OmpRpcSessionSummary } from '../../shared/omp-rpc-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useOmpRpcStore } from '../state/omp-rpc-store';
import { livePaneIdsForMission } from '../orch/mission-reopen';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import {
  groupMissionsForRail,
  missionHasLiveRuntime,
  missionRailResumeCopy,
  railStatusDisplay,
  statusLabel,
} from '../lib/mission-rail-groups';
import {
  missionIdsWithOmpWorkers,
  ompRailMetaFragment,
  summarizeOmpMissionActivity,
} from '../lib/omp-mission-activity';
import {
  loadArchivedMissionIds,
  loadCollapsedSections,
  loadPinnedMissionIds,
  setMissionArchived,
  saveCollapsedSections,
  savePinnedMissionIds,
  togglePinnedMissionId,
  type RailSectionId,
} from '../lib/mission-rail-prefs';
import { formatShortcut } from '../lib/platform';
import { useWorkspaceStore } from '../state/workspace-store';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { useGitScmStore } from '../state/git-scm-store';
import { PixelIcon } from './PixelIcon';
import { ActionCard, EmptyState } from './ActionCard';
import { OperatorHud } from './OperatorHud';
import { askConfirm } from '../state/confirm-store';
import { confirmAndBlockMission } from '../orch/block-mission';
import { promotePlanMissionToExecution } from '../orch/plan-promote-flow';
import {
  usePlanLaneMetricsStore,
} from '../state/plan-lane-metrics-store';
import { AgentDropZone } from './AgentDropZone';
import type { ExternalIssue } from '../../shared/integrations-types';
import { INTEGRATIONS_CHANGED_EVENT } from '../lib/integrations-events';
import { useMissionWizardStore as useWizard } from '../state/mission-wizard-store';
import {
  summarizeMissionBudget,
  summarizeWorkspaceMissionBudgets,
} from '../../shared/mission-budget';
import { humanElapsed } from '../../shared/mission-glance';
import { resolveDispatchAuthorizedAt } from '../../shared/mission-intent';
import {
  missionRailActiveBeat,
  missionRailEmptyBeat,
} from '../../shared/endorphin';
import { EndorphinPresence } from './EndorphinPresence';
import { missionRouteDisplay } from '../lib/mission-route-display';
import { MissionClarifyCards } from './MissionClarifyCards';
import {
  archiveMissionPrompt,
  discardMissionPrompt,
  missionActionCopy,
  missionListAction,
} from '../orch/mission-list-action';
import {
  closeMissionNote,
  closeMissionRuntimeAndPanes,
} from '../orch/close-mission-runtime';

/**
 * Activity Rail — missões **deste workspace** apenas:
 * Fixadas · Em progresso · Na fila · Concluídas + busca.
 * Troca de pasta limpa a lista (orch-store) e recarrega pins locais.
 */

export function MissionRail() {
  const missions = useOrchStore((s) => s.missions);
  const boundWorkspacePath = useOrchStore((s) => s.boundWorkspacePath);
  const paneMissions = useOrchStore((s) => s.paneMissions);
  const handoffs = useOrchStore((s) => s.handoffs);
  const openMissionWizard = useMissionWizardStore((s) => s.openForMission);
  const openAgentic = useWizard((s) => s.openForAgentic);
  const openBoard = useOrchStore((s) => s.openBoard);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const openOmpPanel = useOmpRpcStore((s) => s.openPanel);
  const planMetricsLabel = usePlanLaneMetricsStore((s) => {
    if (s.planDispatched + s.planPromoted + s.planHandoffReady === 0) {
      return null;
    }
    return `plan ${s.planDispatched}→${s.planPromoted} (h:${s.planHandoffReady})`;
  });
  const [extIssues, setExtIssues] = useState<ExternalIssue[]>([]);
  const workspace = useWorkspaceStore((s) => s.current);
  const workspacePath = workspace?.path ?? null;
  const gitBranch = useGitScmStore((s) => s.branch);
  const gitDirtyCount = useGitScmStore(
    (s) => s.staged.length + s.unstaged.length + s.untracked.length,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Re-render the elapsed mission label even when no store event arrives.
  const [, setElapsedTick] = useState(0);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() =>
    loadPinnedMissionIds(workspacePath),
  );
  const [archivedIds, setArchivedIds] = useState<string[]>(() =>
    loadArchivedMissionIds(workspacePath),
  );
  const [collapsed, setCollapsed] = useState<RailSectionId[]>(() =>
    loadCollapsedSections(),
  );
  const [ompSessions, setOmpSessions] = useState<OmpRpcSessionSummary[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    usePlanLaneMetricsStore.getState().hydrate();
  }, []);

  // Omp rpc-ui mission workers are not layout panes — poll + debounced events.
  useEffect(() => {
    let cancelled = false;
    let debounce: number | null = null;
    const refresh = () => {
      void window.nexus.ompRpc.listSessions().then((rows) => {
        if (!cancelled) setOmpSessions(rows);
      });
    };
    refresh();
    const stop = window.nexus.ompRpc.onEvent(() => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(refresh, 250);
    });
    const interval = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      stop();
      if (debounce != null) window.clearTimeout(debounce);
      window.clearInterval(interval);
    };
  }, []);

  // Pins e lista só deste path — ao trocar workspace, recarrega pins locais.
  useEffect(() => {
    setPinnedIds(loadPinnedMissionIds(workspacePath));
    setArchivedIds(loadArchivedMissionIds(workspacePath));
    setQuery('');
    setNote(null);
    useGitScmStore.getState().reset();
    if (workspacePath) void useGitScmStore.getState().refresh();
  }, [workspacePath]);

  const [issuesRefreshKey, setIssuesRefreshKey] = useState(0);
  // Reage a mudança de credencial (salvar token no painel de integrações):
  // sem isto, a seção Issues só populava ao trocar de workspace e ficava stale.
  useEffect(() => {
    const onChanged = () => setIssuesRefreshKey((k) => k + 1);
    window.addEventListener(INTEGRATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INTEGRATIONS_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const issues: ExternalIssue[] = [];
      try {
        if (await window.nexus.integrations.hasGithubToken()) {
          const r = await window.nexus.integrations.listGithubIssues({ limit: 8 });
          if (r.ok) issues.push(...r.issues);
        }
        if (await window.nexus.integrations.hasLinearKey()) {
          const r = await window.nexus.integrations.listLinearIssues({ limit: 8 });
          if (r.ok) issues.push(...r.issues);
        }
      } catch {
        // offline / no token
      }
      if (!cancelled) setExtIssues(issues);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.path, issuesRefreshKey]);

  // Layout no dep: livePaneIds filtra panes mortos do tree — sem isso, o
  // useMemo ficava stale e missão com terminal vivo sumia do “Em progresso”.
  const layoutRoot = useLayoutStore((s) => s.root);
  useEffect(() => {
    if (!note) return;
    const match = note.match(/\b(?:O )?pane ([A-Za-z0-9_-]+) não confirmou\b/i);
    if (!match) return;
    const liveIds = new Set(listPanes(layoutRoot).map((pane) => pane.id));
    if (!liveIds.has(match[1]!)) setNote(null);
  }, [layoutRoot, note]);

  const ompLiveMissionIds = useMemo(
    () => missionIdsWithOmpWorkers(ompSessions),
    [ompSessions],
  );
  const openMissionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const mid of new Set(Object.values(paneMissions))) {
      if (livePaneIdsForMission(mid).length > 0) ids.add(mid);
    }
    for (const mid of ompLiveMissionIds) ids.add(mid);
    return ids;
    // layoutRoot: reavaliar quando o grid muda (spawn/close/split).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneMissions, layoutRoot, ompLiveMissionIds]);

  const handoffCountByMission = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of handoffs) {
      if (!h.missionId) continue;
      map.set(h.missionId, (map.get(h.missionId) ?? 0) + 1);
    }
    return map;
  }, [handoffs]);

  // Só lista missões quando o store está bound a ESTE path (evita flash de
  // outra pasta durante a troca).
  const listReady =
    Boolean(workspacePath) && boundWorkspacePath === workspacePath;
  const localMissions = listReady ? missions : [];

  const sections = useMemo(
    () =>
      groupMissionsForRail({
        missions: listReady ? missions : [],
        openMissionIds,
        pinnedIds,
        archivedIds,
        query,
      }),
    [listReady, missions, openMissionIds, pinnedIds, archivedIds, query],
  );

  // Contador de ativas segue o runtime físico: encerrar precisa fazer o número
  // cair, senão o operador encerra tudo e o rail insiste que há 7 rodando.
  const activeCount = localMissions.filter((m) =>
    missionHasLiveRuntime(m, openMissionIds.has(m.id)),
  ).length;

  const workspaceBudget = useMemo(
    () => summarizeWorkspaceMissionBudgets(localMissions),
    [localMissions],
  );

  const railBeat = useMemo(() => {
    if (!listReady || localMissions.length === 0) {
      return missionRailEmptyBeat(workspace?.name ?? 'este workspace');
    }
    return missionRailActiveBeat(activeCount, localMissions.length);
  }, [
    listReady,
    localMissions.length,
    activeCount,
    workspace?.name,
  ]);

  function toggleSection(id: RailSectionId) {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
      saveCollapsedSections(next);
      return next;
    });
  }

  function togglePin(id: string) {
    setPinnedIds(togglePinnedMissionId(workspacePath, id));
  }

  async function closeOrDiscardMission(m: Mission, active: boolean) {
    const action = missionListAction(m, active);
    if (action === 'none') return;
    if (action === 'close-runtime') {
      setBusy(m.id);
      try {
        const result = await closeMissionRuntimeAndPanes(
          m.id,
          'mission-rail-close',
        );
        if (!result.ok && result.cancelled) return;
        setNote(
          result.ok
            ? closeMissionNote(result.terminatedSessionIds.length)
            : result.error ?? 'Não foi possível provar a saída dos processos.',
        );
      } finally {
        // Sem finally, uma rejeição deixava `busy` preso e travava TODOS os
        // botões da lista — a missão “não encerrava” e nada explicava por quê.
        setBusy(null);
      }
      return;
    }
    if (action === 'archive') {
      const ok = await askConfirm({
        ...archiveMissionPrompt(m),
        confirmLabel: 'Arquivar missão',
      });
      if (!ok) return;
      setArchivedIds(setMissionArchived(workspacePath, m.id, true));
      setNote('Missão arquivada. Nada foi apagado — está em “Arquivadas”.');
      return;
    }
    const prompt = discardMissionPrompt(m);
    const ok = await askConfirm({ ...prompt, danger: true });
    if (!ok) return;
    setNote(null);
    void window.nexus.orch
      .removeMission(m.id)
      .then((r) => {
        if (!r.removed) setNote('Missão já não estava na lista.');
        setPinnedIds((prev) => {
          const next = prev.filter((x) => x !== m.id);
          savePinnedMissionIds(workspacePath, next);
          return next;
        });
      })
      .catch((cause) => {
        setNote(
          cause instanceof Error ? cause.message : 'Falha ao remover a missão.',
        );
      });
  }

  async function blockMission(m: Mission) {
    setBusy(m.id);
    setNote(null);
    const result = await confirmAndBlockMission(m);
    if (result.ok) setNote('Missão encerrada como bloqueada.');
    else if (!result.cancelled && result.error) setNote(result.error);
    setBusy(null);
  }

  /** Plan mode → standard PREVC (operator approved the design). */
  async function promotePlan(m: Mission) {
    setBusy(m.id);
    setNote(null);
    const result = await promotePlanMissionToExecution(m);
    if (result.cancelled) {
      setBusy(null);
      return;
    }
    if (result.ok) {
      setNote(
        result.detail?.includes('Sem pane')
          ? 'Plano promovido — PREVC ativo (sem pane para notificar).'
          : 'Plano promovido — PREVC ativo e orquestrador notificado.',
      );
    } else if (result.error) {
      setNote(result.error);
    }
    setBusy(null);
  }

  function missionMeta(mission: Mission, liveInGrid: boolean): string {
    const hands = handoffCountByMission.get(mission.id) ?? 0;
    const handBit =
      hands > 0 ? ` · ${hands} entrega${hands === 1 ? '' : 's'}` : '';
    const budget = summarizeMissionBudget(mission);
    const budgetBit =
      budget.hasContract && budget.label !== '—'
        ? ` · ${budget.label}`
        : '';
    const route = missionRouteDisplay(mission.latestRoute);
    const routeBit = route ? ` · ${route.meta}` : '';
    const laneBit =
      mission.intentContract?.lane === 'plan'
        ? ' · plano'
        : mission.intentContract?.lane === 'consult'
          ? ' · consulta'
          : '';
    const started = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(mission.createdAt);

    // Status já vai na pill — meta fica operacional (tempo / panes / budget).
    if (mission.status === 'pending' && !liveInGrid) {
      return `Retomar · ${started}${laneBit}${handBit}${budgetBit}${routeBit}`;
    }

    if (liveInGrid || ompLiveMissionIds.has(mission.id)) {
      const paneIds = Object.entries(paneMissions)
        .filter(([, missionId]) => missionId === mission.id)
        .map(([paneId]) => paneId);
      const live = livePaneIdsForMission(mission.id);
      const ids = live.length > 0 ? live : paneIds;
      const busyCount = ids.filter(
        (paneId) => paneStates.get(paneId) === 'busy',
      ).length;
      const spawningCount = ids.filter(
        (paneId) => paneStates.get(paneId) === 'spawning',
      ).length;
      const omp = summarizeOmpMissionActivity(ompSessions, mission.id);
      const ompBit = ompRailMetaFragment(omp);
      // FALE HUMANO no rail: "pane" é encanamento; a pessoa acompanha AGENTES
      // e há quanto tempo a missão roda.
      const elapsed = humanElapsed(
        resolveDispatchAuthorizedAt(mission),
        Date.now(),
      );
      const elapsedBit = elapsed ? ` · ${elapsed}` : '';
      const ompSuffix = ompBit ? ` · ${ompBit}` : '';
      if (busyCount > 0 || omp.working > 0) {
        const agents = busyCount + omp.working;
        return `${agents} agente${agents === 1 ? '' : 's'} trabalhando${elapsedBit}${ompSuffix}${handBit}${budgetBit}${routeBit}`;
      }
      if (spawningCount > 0 || omp.starting > 0) {
        const agents = spawningCount + omp.starting;
        return `${agents} agente${agents === 1 ? '' : 's'} iniciando${elapsedBit}${ompSuffix}${handBit}${budgetBit}${routeBit}`;
      }
      if (ids.length > 0 || omp.idle > 0) {
        const agents = ids.length + omp.idle;
        return `${agents} agente${agents === 1 ? '' : 's'} no grid${elapsedBit}${ompSuffix}${handBit}${budgetBit}${routeBit}`;
      }
      if (ompBit) {
        return `${ompBit}${elapsedBit}${handBit}${budgetBit}${routeBit}`;
      }
    }

    if (mission.status === 'running') {
      return `${missionRailResumeCopy(mission.status, liveInGrid, mission.intentState).meta ?? 'Retomar'}${laneBit}${handBit}${budgetBit}${routeBit}`;
    }
    if (mission.status === 'blocked') {
      return `${
        missionRailResumeCopy(
          mission.status,
          liveInGrid,
          mission.intentState,
        ).meta ?? 'Clique para retomar'
      }${laneBit}${handBit}${budgetBit}${routeBit}`;
    }
    if (mission.status === 'done' || mission.status === 'failed') {
      return `${started}${laneBit}${handBit}${budgetBit}${routeBit}`;
    }
    return `${statusLabel(mission.status)} · ${started}${laneBit}${handBit}${budgetBit}${routeBit}`;
  }

  function selectMission(m: Mission) {
    setBusy(m.id);
    setNote(null);
    // Mission-only omp rpc workers have no PTY pane — open the OMP drawer so
    // the operator can see / approve without a dead reopen.
    const ompOnly =
      ompLiveMissionIds.has(m.id) &&
      livePaneIdsForMission(m.id).length === 0;
    if (ompOnly) {
      openOmpPanel();
      setBusy(null);
      return;
    }
    void confirmAndReopenMission(m)
      .then((r) => {
        if (!r.ok) setNote(r.error ?? 'Falha ao retomar.');
        else setNote(null);
      })
      .catch((cause) => {
        setNote(
          cause instanceof Error ? cause.message : 'Falha ao retomar a missão.',
        );
      })
      .finally(() => setBusy(null));
  }

  return (
    <aside className="mission-rail activity-rail" aria-label="Missões deste workspace">
      <header className="mission-rail__head mission-rail__head--endorphin">
        <div className="mission-rail__heading">
          <span className="mission-rail__kicker">{railBeat.kicker}</span>
          <span className="mission-rail__title">Missões</span>
          <span
            className="mission-rail__workspace"
            title={workspace?.path ?? undefined}
          >
            {workspace?.name ?? 'sem pasta'}
          </span>
          <span className="mission-rail__summary" aria-live="polite">
            {!listReady
              ? 'a carregar…'
              : railBeat.title}
            {listReady && localMissions.length > 0 ? (
              <span className="mission-rail__summary-line">{railBeat.line}</span>
            ) : null}
          </span>
        </div>
        <div className="mission-rail__head-actions">
          <button
            type="button"
            className="mission-rail__new mission-rail__new--primary mission-rail__new--story"
            title={`Nova missão neste workspace (${formatShortcut('mod', 'N')})`}
            aria-label="Nova missão neste workspace"
            onClick={openMissionWizard}
          >
            <PixelIcon name="plus" size={12} /> <span>Nova missão</span>
          </button>
          <button
            type="button"
            className="mission-rail__board-btn"
            title={`Painel de operações (${formatShortcut('mod', 'B')})`}
            aria-label="Abrir painel de operações"
            onClick={openBoard}
          >
            <PixelIcon name="board" size={11} />
          </button>
        </div>
        {/* Chips do polish: a narrativa endorfinada fica acima, números aqui. */}
        <div className="mission-rail__meta" role="status" aria-live="polite">
          {!listReady ? (
            <span className="mission-rail__chip mission-rail__chip--muted">
              a carregar…
            </span>
          ) : (
            <>
              {gitBranch && (
                <span
                  className="mission-rail__chip mission-rail__chip--branch"
                  title={`Worktree em ${gitBranch}${
                    gitDirtyCount > 0
                      ? ` · ${gitDirtyCount} alteração(ões) pendente(s)`
                      : ' · limpo'
                  }`}
                >
                  <PixelIcon name="files" size={10} />
                  <span className="mission-rail__chip-value">{gitBranch}</span>
                  {gitDirtyCount > 0 && (
                    <span className="mission-rail__chip-label">
                      {gitDirtyCount}△
                    </span>
                  )}
                </span>
              )}
              <span
                className="mission-rail__chip"
                title="Missões em progresso ou bloqueadas neste workspace"
              >
                <span className="mission-rail__chip-value">{activeCount}</span>
                <span className="mission-rail__chip-label">
                  ativa{activeCount === 1 ? '' : 's'}
                </span>
              </span>
              <span
                className="mission-rail__chip"
                title="Total de missões listadas nesta pasta"
              >
                <span className="mission-rail__chip-value">
                  {localMissions.length}
                </span>
                <span className="mission-rail__chip-label">aqui</span>
              </span>
              {workspaceBudget.activeCount > 0 && (
                <span
                  className={`mission-rail__chip mission-rail__chip--budget${
                    workspaceBudget.totalMaxTokens > 0 &&
                    workspaceBudget.totalSpentTokens /
                      Math.max(1, workspaceBudget.totalMaxTokens) >=
                      0.8
                      ? ' mission-rail__chip--warn'
                      : ''
                  }`}
                  title="Orçamento agregado (intent contract: tokens estimados)"
                >
                  <span className="mission-rail__chip-value">
                    {workspaceBudget.shortLabel}
                  </span>
                </span>
              )}
              {planMetricsLabel && (
                <span
                  className="mission-rail__chip mission-rail__chip--muted"
                  title="Métricas locais: missões plan despachadas → promovidas (handoffs de plano)"
                >
                  <span className="mission-rail__chip-value">
                    {planMetricsLabel}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
      </header>

      <div className="mission-rail__tools">
        <label className="activity-rail__search">
          <span className="settings-visually-hidden">
            Filtrar missões deste workspace
          </span>
          <span className="activity-rail__search-icon" aria-hidden="true">
            <PixelIcon name="search" size={11} />
          </span>
          <input
            className="activity-rail__search-input"
            type="search"
            placeholder="Filtrar missões…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <AgentDropZone compact />
      </div>

      <div className="activity-rail__body">
        <MissionClarifyCards missions={missions} handoffs={handoffs} />
        {extIssues.length > 0 && (
          <section className="activity-rail__section activity-rail__section--issues">
            <div className="activity-rail__section-head activity-rail__section-head--static">
              <span className="activity-rail__section-label">Issues</span>
              <span className="activity-rail__section-count">{extIssues.length}</span>
            </div>
            <ul className="mission-rail__list activity-rail__list">
              {extIssues.map((i) => (
                <li key={i.id} className="mission-rail__row">
                  <button
                    type="button"
                    className="mission-rail__item"
                    title={i.url}
                    onClick={() =>
                      openAgentic(
                        `${i.provider === 'github' ? `GitHub #${i.number}` : 'Linear'}: ${i.title}\n${i.url}`,
                        'imported-issue',
                      )
                    }
                  >
                    <span
                      className={`mission-rail__dot ${
                        i.provider === 'github'
                          ? 'mission-rail__dot--pending'
                          : 'mission-rail__dot--running'
                      }`}
                    />
                    <span className="mission-rail__item-body">
                      <span className="mission-rail__item-title">
                        {i.provider === 'github' ? `#${i.number} ` : ''}
                        {i.title}
                      </span>
                      <span className="mission-rail__item-meta">
                        {i.provider} · {i.state}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!listReady ? (
          <EmptyState
            className="activity-rail__empty"
            icon="mission"
            title="A carregar missões"
            body={<p>Sincronizando o trabalho desta pasta…</p>}
          />
        ) : localMissions.length === 0 ? (
          <EmptyState
            className="activity-rail__empty mission-rail__empty--story"
            icon="mission"
            title={railBeat.title}
            body={
              <>
                <EndorphinPresence
                  kicker={railBeat.kicker}
                  mood="idle"
                  size={44}
                  className="endorphin-presence--row mission-rail__empty-presence"
                />
                <p>{railBeat.line}</p>
              </>
            }
            action={
              <ActionCard
                icon="mission"
                title="Nova missão"
                subtitle="neste workspace"
                variant="primary"
                size="sm"
                onClick={openMissionWizard}
              />
            }
          />
        ) : (
          <div className="activity-rail__missions">
            {sections.map((section) => {
              // Esconde seções vazias (sem “Nada aqui” / Em progresso 0).
              if (section.missions.length === 0) return null;
              const isCollapsed = collapsed.includes(section.id);
              return (
                <section
                  key={section.id}
                  className={`activity-rail__section activity-rail__section--${section.id}`}
                >
                  <button
                    type="button"
                    className="activity-rail__section-head"
                    onClick={() => toggleSection(section.id)}
                    aria-expanded={!isCollapsed}
                  >
                    <span
                      className="activity-rail__section-caret"
                      aria-hidden="true"
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <span className="activity-rail__section-label">
                      {section.label}
                    </span>
                    <span className="activity-rail__section-count">
                      {section.missions.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul className="mission-rail__list activity-rail__list">
                      {section.missions.map((m) => {
                        const liveInGrid = openMissionIds.has(m.id);
                        const pinned = pinnedIds.includes(m.id);
                        const lane = m.intentContract?.lane ?? null;
                        const statusUi = railStatusDisplay(
                          m.status,
                          liveInGrid,
                          m.intentState,
                          lane,
                        );
                        const resumeCopy = missionRailResumeCopy(
                          m.status,
                          liveInGrid,
                          m.intentState,
                          lane,
                        );
                        const routeDisplay = missionRouteDisplay(m.latestRoute);
                        const dotStatus =
                          m.status === 'blocked' || m.status === 'failed'
                            ? m.status
                            : liveInGrid || m.status === 'running'
                              ? 'running'
                              : m.status;
                        return (
                          <li key={m.id} className="mission-rail__row">
                            <button
                              className={`mission-rail__item ${
                                liveInGrid
                                  ? 'mission-rail__item--active'
                                  : 'mission-rail__item--idle'
                              } mission-rail__item--tone-${statusUi.tone}`}
                              disabled={busy !== null}
                              aria-current={liveInGrid ? 'true' : undefined}
                              aria-label={`${m.title}. ${statusUi.label}. ${resumeCopy.title}`}
                              title={`${m.title}\n${resumeCopy.title}${
                                routeDisplay ? `\n${routeDisplay.title}` : ''
                              }`}
                              onClick={() => selectMission(m)}
                            >
                              <span
                                className={`mission-rail__dot mission-rail__dot--${dotStatus}`}
                              />
                              <span className="mission-rail__item-body">
                                {/* Título em linha própria (até 2 linhas): o
                                    status pill ao lado cortava "Execução + QA"
                                    em "Execução+…". */}
                                <span className="mission-rail__item-title">
                                  {pinned && (
                                    <PixelIcon name="star" size={9} />
                                  )}
                                  {pinned ? ' ' : ''}
                                  {m.title}
                                </span>
                                <span className="mission-rail__item-meta">
                                  <span
                                    className={`mission-rail__status mission-rail__status--${statusUi.tone}`}
                                  >
                                    {statusUi.label}
                                  </span>
                                  <span className="mission-rail__item-meta-text">
                                    {busy === m.id
                                      ? 'Retomando…'
                                      : missionMeta(m, liveInGrid)}
                                  </span>
                                </span>
                              </span>
                            </button>
                            {m.intentContract?.lane === 'plan' &&
                              m.status !== 'done' &&
                              m.status !== 'failed' && (
                              <button
                                type="button"
                                className="mission-rail__block"
                                disabled={busy !== null}
                                title="Executar plano — promover lane plan → código PREVC"
                                aria-label={`Executar plano da missão ${m.title}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void promotePlan(m);
                                }}
                              >
                                <PixelIcon name="mission" size={10} />
                              </button>
                            )}
                            {(m.status === 'pending' ||
                              m.status === 'running') && (
                              <button
                                type="button"
                                className="mission-rail__block"
                                disabled={busy !== null}
                                title="Encerrar como bloqueada (com justificativa)"
                                aria-label={`Encerrar missão ${m.title} como bloqueada`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void blockMission(m);
                                }}
                              >
                                <PixelIcon name="warn" size={10} />
                              </button>
                            )}
                            <button
                              type="button"
                              className="mission-rail__pin"
                              title={pinned ? 'Desafixar' : 'Fixar no topo'}
                              aria-label={
                                pinned ? 'Desafixar missão' : 'Fixar missão'
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePin(m.id);
                              }}
                            >
                              <PixelIcon
                                name={pinned ? 'star' : 'star-outline'}
                                size={11}
                              />
                            </button>
                            {archivedIds.includes(m.id) ? (
                              <button
                                className="mission-rail__remove"
                                disabled={busy !== null}
                                title="Trazer de volta para a lista"
                                aria-label={`Desarquivar missão ${m.title}`}
                                onClick={() => {
                                  setArchivedIds(
                                    setMissionArchived(
                                      workspacePath,
                                      m.id,
                                      false,
                                    ),
                                  );
                                  setNote(null);
                                }}
                              >
                                <PixelIcon name="restart" size={10} />
                              </button>
                            ) : (
                              missionListAction(m, liveInGrid) !== 'none' && (
                                <button
                                  className="mission-rail__remove"
                                  disabled={busy !== null}
                                  title={
                                    missionActionCopy(
                                      missionListAction(m, liveInGrid),
                                    ).title
                                  }
                                  aria-label={`${
                                    missionActionCopy(
                                      missionListAction(m, liveInGrid),
                                    ).verb
                                  } missão ${m.title}`}
                                  onClick={() =>
                                    closeOrDiscardMission(m, liveInGrid)
                                  }
                                >
                                  <PixelIcon name="close" size={10} />
                                </button>
                              )
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {note && (
        <p className="mission-rail__note" role="status">
          {note}
        </p>
      )}

      <footer className="activity-rail__footer">
        {/* XP no rail; conta CLI fica só na workspace bar (menos mistura). */}
        <OperatorHud />
      </footer>
    </aside>
  );
}
