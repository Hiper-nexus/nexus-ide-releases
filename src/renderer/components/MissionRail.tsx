import { useEffect, useMemo, useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useSessionStateStore } from '../state/session-state-store';
import { livePaneIdsForMission } from '../orch/mission-reopen';
import { useHomeStore } from '../state/home-store';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import {
  groupMissionsForRail,
  missionIsOperationallyActive,
  missionRailResumeCopy,
  railDotStatus,
  railStatusDisplay,
  statusLabel,
} from '../lib/mission-rail-groups';
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
import { toUserFacingMissionError } from '../lib/user-facing-mission-error';
import { confirmAndBlockMission } from '../orch/block-mission';
import { promotePlanMissionToExecution } from '../orch/plan-promote-flow';
import { usePlanLaneMetricsStore } from '../state/plan-lane-metrics-store';
import { AgentDropZone } from './AgentDropZone';
import type { ExternalIssue } from '../../shared/integrations-types';
import { INTEGRATIONS_CHANGED_EVENT } from '../lib/integrations-events';
import { summarizeWorkspaceMissionBudgets } from '../../shared/mission-budget';
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
  removeMissionPrompt,
  discardMissionPrompt,
  missionActionCopy,
  missionListAction,
} from '../orch/mission-list-action';
import {
  closeMissionNote,
  closeMissionRuntimeAndPanes,
} from '../orch/close-mission-runtime';
import { paneSessionView } from '../../shared/pane-session-view';
import { hasAutomaticTechnicalRecovery } from '../../shared/mission-recovery-policy';
import { hasMissionFailureNotes } from '../../shared/mission-failure-presentation';
import { missionBlockCause } from '../../shared/mission-block-cause';

/** A segunda linha do card é estreita: corta o porquê, nunca a ação do card. */
const RAIL_CAUSE_LIMIT = 64;

function clipRailCause(value: string): string {
  if (value.length <= RAIL_CAUSE_LIMIT) return value;
  const cut = value.slice(0, RAIL_CAUSE_LIMIT - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

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
  const openAgentic = useMissionWizardStore((s) => s.openForAgentic);
  const openBoard = useOrchStore((s) => s.openBoard);
  const paneStates = useSessionStateStore((s) => s.paneStates);
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    usePlanLaneMetricsStore.getState().hydrate();
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
    return () =>
      window.removeEventListener(INTEGRATIONS_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    // Never unlock/decrypt forge credentials merely because the activity rail
    // mounted. On macOS safeStorage may synchronously wait for Keychain UI and
    // freeze Electron's main thread before the first usable frame. Issue sync
    // starts only after an explicit integrations change in this renderer
    // session (saving/authenticating from the Integrations panel).
    if (issuesRefreshKey === 0) return;
    let cancelled = false;
    void (async () => {
      const issues: ExternalIssue[] = [];
      try {
        if (await window.nexus.integrations.hasGithubToken()) {
          const r = await window.nexus.integrations.listGithubIssues({
            limit: 8,
          });
          if (r.ok) issues.push(...r.issues);
        }
        if (await window.nexus.integrations.hasLinearKey()) {
          const r = await window.nexus.integrations.listLinearIssues({
            limit: 8,
          });
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
  const focusPane = useLayoutStore((s) => s.focus);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  useEffect(() => {
    if (!note) return;
    const match = note.match(/\b(?:O )?pane ([A-Za-z0-9_-]+) não confirmou\b/i);
    if (!match) return;
    const liveIds = new Set(listPanes(layoutRoot).map((pane) => pane.id));
    if (!liveIds.has(match[1]!)) setNote(null);
  }, [layoutRoot, note]);

  const openMissionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const mid of new Set(Object.values(paneMissions))) {
      if (livePaneIdsForMission(mid).length > 0) ids.add(mid);
    }
    return ids;
    // layoutRoot: reavaliar quando o grid muda (spawn/close/split).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneMissions, layoutRoot]);

  const panesByMission = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof listPanes>>();
    for (const pane of listPanes(layoutRoot)) {
      const missionId = paneMissions[pane.id] ?? pane.missionId;
      if (!missionId || pane.kind !== 'cli-agent') continue;
      const panes = grouped.get(missionId) ?? [];
      panes.push(pane);
      grouped.set(missionId, panes);
    }
    return grouped;
  }, [layoutRoot, paneMissions]);

  const handoffCountByMission = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of handoffs) {
      if (!h.missionId) continue;
      map.set(h.missionId, (map.get(h.missionId) ?? 0) + 1);
    }
    return map;
  }, [handoffs]);

  const latestHandoffByMission = useMemo(() => {
    const map = new Map<string, (typeof handoffs)[number]>();
    for (const handoff of handoffs) {
      if (!handoff.missionId) continue;
      const previous = map.get(handoff.missionId);
      if (!previous || handoff.createdAt > previous.createdAt) {
        map.set(handoff.missionId, handoff);
      }
    }
    return map;
  }, [handoffs]);

  const latestHandoffByAgent = useMemo(() => {
    const map = new Map<string, (typeof handoffs)[number]>();
    for (const handoff of handoffs) {
      const agent = handoff.fromAgent?.trim().toLocaleLowerCase();
      if (!handoff.missionId || !agent) continue;
      const key = `${handoff.missionId}\u0000${agent}`;
      const previous = map.get(key);
      if (!previous || handoff.createdAt > previous.createdAt) {
        map.set(key, handoff);
      }
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

  // Entre tentativas técnicas o PTY pode não existir, mas o Main ainda possui
  // a missão e o backoff. Conte essa janela como ativa sem confundi-la com um
  // runtime físico; bloqueio humano encerrado continua fazendo o número cair.
  const activeCount = localMissions.filter((m) =>
    missionIsOperationallyActive(m, openMissionIds.has(m.id)),
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
  }, [listReady, localMissions.length, activeCount, workspace?.name]);

  function toggleSection(id: RailSectionId) {
    setCollapsed((prev) => {
      const next = prev.includes(id)
        ? prev.filter((s) => s !== id)
        : [...prev, id];
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
    if (action === 'close-runtime' || action === 'stop-recovery') {
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
            : (result.error ??
                'Não foi possível provar a saída dos processos.'),
        );
      } finally {
        // Sem finally, uma rejeição deixava `busy` preso e travava TODOS os
        // botões da lista — a missão “não encerrava” e nada explicava por quê.
        setBusy(null);
      }
      return;
    }
    const prompt =
      action === 'remove' ? removeMissionPrompt(m) : discardMissionPrompt(m);
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
        setArchivedIds((prev) => prev.filter((id) => id !== m.id));
      })
      .catch((cause) => {
        setNote(toUserFacingMissionError(cause, 'Falha ao remover a missão.'));
      });
  }

  async function purgeMission(m: Mission) {
    const ok = await askConfirm({ ...removeMissionPrompt(m), danger: true });
    if (!ok) return;
    setBusy(m.id);
    setNote(null);
    try {
      const r = await window.nexus.orch.removeMission(m.id);
      if (!r.removed) setNote('Missão já não estava na lista.');
      setPinnedIds((prev) => {
        const next = prev.filter((x) => x !== m.id);
        savePinnedMissionIds(workspacePath, next);
        return next;
      });
      setArchivedIds((prev) => prev.filter((id) => id !== m.id));
    } catch (cause) {
      setNote(toUserFacingMissionError(cause, 'Falha ao remover a missão.'));
    } finally {
      setBusy(null);
    }
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
    const recovering = hasAutomaticTechnicalRecovery(mission);
    const displayIntentState = mission.intentState;
    const hands = handoffCountByMission.get(mission.id) ?? 0;
    const handBit = hands > 0
      ? ` · ${hands} entrega${hands === 1 ? '' : 's'}`
      : '';
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

    // O status já vai na pill. A segunda linha só responde ao que o operador
    // precisa decidir agora; rota, orçamento e hashes ficam no diagnóstico.
    if (mission.status === 'pending' && !liveInGrid) {
      return `Retomar · ${started}${laneBit}${handBit}`;
    }

    if (recovering) {
      const recovery = missionRailResumeCopy(
        mission.status,
        liveInGrid,
        'blocked_technical',
      );
      return `${recovery.meta ?? 'Recuperação automática'}${laneBit}${handBit}`;
    }

    if (mission.intentState === 'blocked_technical') {
      return `Falha técnica · ver diagnóstico${laneBit}${handBit}`;
    }

    if (liveInGrid) {
      const paneIds = Object.entries(paneMissions)
        .filter(([, missionId]) => missionId === mission.id)
        .map(([paneId]) => paneId);
      const live = livePaneIdsForMission(mission.id);
      const ids = live.length > 0 ? live : paneIds;
      const activeIds = ids.filter((paneId) => {
        const state = paneStates.get(paneId);
        return state !== 'exited' && state !== 'hibernated';
      });
      const busyCount = activeIds.filter(
        (paneId) => paneStates.get(paneId) === 'busy',
      ).length;
      const spawningCount = activeIds.filter(
        (paneId) => paneStates.get(paneId) === 'spawning',
      ).length;
      const endedCount = ids.filter(
        (paneId) => paneStates.get(paneId) === 'exited',
      ).length;
      // FALE HUMANO no rail: "pane" é encanamento; a pessoa acompanha AGENTES
      // e há quanto tempo a missão roda.
      const elapsed = humanElapsed(
        resolveDispatchAuthorizedAt(mission),
        Date.now(),
      );
      const elapsedBit = elapsed ? ` · ${elapsed}` : '';
      if (busyCount > 0) {
        return `${busyCount} agente${busyCount === 1 ? '' : 's'} trabalhando${elapsedBit}${handBit}`;
      }
      if (spawningCount > 0) {
        return `${spawningCount} agente${spawningCount === 1 ? '' : 's'} iniciando${elapsedBit}${handBit}`;
      }
      if (activeIds.length > 0) {
        return `${activeIds.length} agente${activeIds.length === 1 ? '' : 's'} no grid${elapsedBit}${handBit}`;
      }
      if (endedCount > 0) {
        const latestStatus = latestHandoffByMission.get(mission.id)?.status;
        const report =
          latestStatus === 'blocked' || latestStatus === 'stalled'
            ? ' · bloqueio reportado'
            : latestStatus === 'failed'
              ? ' · falha reportada'
              : '';
        return `${endedCount} agente${endedCount === 1 ? '' : 's'} encerrado${endedCount === 1 ? '' : 's'}${report}${handBit}`;
      }
    }

    if (mission.status === 'running') {
      return `${missionRailResumeCopy(mission.status, liveInGrid, displayIntentState).meta ?? 'Retomar'}${laneBit}${handBit}`;
    }
    if (mission.status === 'blocked') {
      // O card mostra o PORQUÊ, não só "Clique para retomar": a razão já está
      // gravada na descrição da missão e é o que decide o próximo passo.
      const cause = missionBlockCause({
        status: mission.status,
        intentState: mission.intentState ?? null,
        description: mission.description ?? '',
      });
      // Causa desconhecida ADMITE que é desconhecida: "Clique para retomar"
      // escondia que o Nexus também não sabia por que a missão parou.
      const why =
        cause.code === 'unknown'
          ? 'Motivo não registrado · ver diagnóstico'
          : clipRailCause(cause.headline);
      return `${why}${laneBit}${handBit}`;
    }
    if (mission.status === 'done' || mission.status === 'failed') {
      return `${started}${laneBit}${handBit}`;
    }
    return `${statusLabel(mission.status)} · ${started}${laneBit}${handBit}`;
  }

  function selectMission(m: Mission) {
    setBusy(m.id);
    setNote(null);
    // Terminal rows are durable reports, not dormant runtimes. Opening one
    // must never materialize a new CLI merely to recover text that Main
    // already persisted with the mission.
    if (m.status === 'done' || m.status === 'failed') {
      useOrchStore.getState().openMissionDetail(m.id);
      setBusy(null);
      return;
    }
    // Already on screen: bring it to the front. Clicking a mission whose pane
    // was alive fell straight into reopen, which neither focused the pane nor
    // dismissed the home screen — so the mission "did not open" and the
    // operator kept looking at "Pronto para planejar".
    const livePanes = livePaneIdsForMission(m.id);
    if (livePanes.length > 0) {
      useHomeStore.getState().hide();
      focusPane(livePanes[0]!);
      setBusy(null);
      return;
    }
    if (hasAutomaticTechnicalRecovery(m)) {
      // O diagnóstico mostra a tentativa N/8, a razão persistida e a saída
      // manual quando a recuperação não cede — a nota antiga era um beco.
      useOrchStore.getState().openMissionDetail(m.id);
      setBusy(null);
      return;
    }
    // A technically failed mission opens its diagnostic first: the operator
    // sees WHY it stopped and chooses "Retomar" from there, instead of a
    // blind reopen that repeats the same failure without explanation.
    if (
      m.status === 'blocked' &&
      hasMissionFailureNotes(m.description ?? '')
    ) {
      useOrchStore.getState().openMissionDetail(m.id);
      setBusy(null);
      return;
    }
    void confirmAndReopenMission(m)
      .then((r) => {
        if (!r.ok) setNote(r.error ?? 'Falha ao retomar.');
        else {
          setNote(null);
          // A reopened mission owns the screen; the home panel must step aside.
          useHomeStore.getState().hide();
        }
      })
      .catch((cause) => {
        setNote(
          cause instanceof Error ? cause.message : 'Falha ao retomar a missão.',
        );
      })
      .finally(() => setBusy(null));
  }

  return (
    <aside
      className="mission-rail activity-rail"
      aria-label="Missões deste workspace"
    >
      <header className="mission-rail__head mission-rail__head--endorphin">
        <div className="mission-rail__heading">
          <span className="mission-rail__kicker">Missões</span>
          <span
            className="mission-rail__workspace"
            title={workspace?.path ?? undefined}
          >
            {workspace?.name ?? 'sem pasta'}
          </span>
          <span className="mission-rail__summary" aria-live="polite">
            {!listReady
              ? 'a carregar…'
              : `${activeCount} ativa${activeCount === 1 ? '' : 's'} · ${
                  localMissions.length
                } ${localMissions.length === 1 ? 'missão' : 'missões'}`}
          </span>
        </div>
        <div className="mission-rail__head-actions">
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
      </header>

      <details className="mission-rail__operations">
        <summary>
          <PixelIcon name="config" size={10} />
          <span>Operações</span>
          {gitDirtyCount > 0 && (
            <span className="mission-rail__operations-alert">
              {gitDirtyCount}{' '}
              {gitDirtyCount === 1 ? 'alteração' : 'alterações'}
            </span>
          )}
        </summary>
        <div className="mission-rail__operations-body">
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
                        ? ` · ${gitDirtyCount} ${
                            gitDirtyCount === 1
                              ? 'alteração pendente'
                              : 'alterações pendentes'
                          }`
                        : ' · limpo'
                    }`}
                  >
                    <PixelIcon name="files" size={10} />
                    <span className="mission-rail__chip-value">
                      {gitBranch}
                    </span>
                    {gitDirtyCount > 0 && (
                      <span className="mission-rail__chip-label">
                        {gitDirtyCount}△
                      </span>
                    )}
                  </span>
                )}
                <span className="mission-rail__chip">
                  <span className="mission-rail__chip-value">
                    {activeCount}
                  </span>
                  <span className="mission-rail__chip-label">
                    ativa{activeCount === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="mission-rail__chip">
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
                    title="Orçamento agregado das missões ativas"
                  >
                    <span className="mission-rail__chip-value">
                      {workspaceBudget.shortLabel}
                    </span>
                  </span>
                )}
                {planMetricsLabel && (
                  <span className="mission-rail__chip mission-rail__chip--muted">
                    <span className="mission-rail__chip-value">
                      {planMetricsLabel}
                    </span>
                  </span>
                )}
              </>
            )}
          </div>
          <AgentDropZone compact />
        </div>
      </details>

      {(localMissions.length >= 4 || extIssues.length > 0) && (
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
        </div>
      )}

      <div className="activity-rail__body">
        <MissionClarifyCards missions={missions} handoffs={handoffs} />
        {extIssues.length > 0 && (
          <section className="activity-rail__section activity-rail__section--issues">
            <div className="activity-rail__section-head activity-rail__section-head--static">
              <span className="activity-rail__section-label">Issues</span>
              <span className="activity-rail__section-count">
                {extIssues.length}
              </span>
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
                onClick={() => openAgentic()}
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
                        const missionPanes = panesByMission.get(m.id) ?? [];
                        const pinned = pinnedIds.includes(m.id);
                        const lane = m.intentContract?.lane ?? null;
                        const hasActivePaneRuntime = missionPanes.some(
                          (pane) => {
                            const state = paneStates.get(pane.id);
                            return (
                              state === undefined ||
                              state === 'spawning' ||
                              state === 'busy' ||
                              state === 'idle'
                            );
                          },
                        );
                        const hasObservedRuntime = missionPanes.length > 0;
                        const hasActiveRuntime =
                          hasActivePaneRuntime ||
                          (!hasObservedRuntime &&
                            Boolean(m.orchestratorSessionId));
                        const recovering =
                          hasAutomaticTechnicalRecovery(m);
                        const displayIntentState = m.intentState;
                        const technicalRecovery =
                          m.intentState === 'blocked_technical'
                            ? recovering
                              ? 'recovering'
                              : 'exhausted'
                            : undefined;
                        const statusUi = railStatusDisplay(
                          m.status,
                          liveInGrid,
                          displayIntentState,
                          lane,
                          {
                            hasActiveRuntime,
                            latestHandoffStatus:
                              latestHandoffByMission.get(m.id)?.status,
                            technicalRecovery,
                          },
                        );
                        const resumeCopy = missionRailResumeCopy(
                          m.status,
                          liveInGrid,
                          recovering
                            ? 'blocked_technical'
                            : displayIntentState,
                          lane,
                          technicalRecovery,
                        );
                        const openTitle =
                          m.status === 'done' || m.status === 'failed'
                            ? 'Ver resultado final persistido'
                            : resumeCopy.title;
                        const routeDisplay = missionRouteDisplay(m.latestRoute);
                        const canPromotePlan =
                          lane === 'plan' &&
                          m.status !== 'done' &&
                          m.status !== 'failed';
                        const canBlockMission =
                          m.status === 'pending' || m.status === 'running';
                        const listAction = missionListAction(m, liveInGrid);
                        const isArchived = archivedIds.includes(m.id);
                        const hasRemoveAction = listAction !== 'none';
                        const rowActionCount =
                          Number(canPromotePlan) +
                          Number(canBlockMission) +
                          1 +
                          Number(isArchived) +
                          Number(hasRemoveAction);
                        const dotStatus = railDotStatus(
                          m.status,
                          statusUi.tone,
                          liveInGrid,
                        );
                        return (
                          <li
                            key={m.id}
                            className="mission-rail__row"
                            data-action-count={rowActionCount}
                          >
                            <button
                              className={`mission-rail__item ${
                                liveInGrid
                                  ? 'mission-rail__item--active'
                                  : 'mission-rail__item--idle'
                              } mission-rail__item--tone-${statusUi.tone}`}
                              data-active={liveInGrid ? 'true' : 'false'}
                              disabled={busy !== null}
                              aria-current={liveInGrid ? 'true' : undefined}
                              aria-label={`${m.title}. ${statusUi.label}. ${openTitle}`}
                              title={`${m.title}\n${openTitle}${
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
                                  {pinned && <PixelIcon name="star" size={9} />}
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
                            {/* A frota aparece sempre que existirem panes da
                                missão: exigir `liveInGrid` escondia os agentes
                                exatamente quando o operador procurava por eles
                                (missão rodando fora do foco atual). */}
                            {missionPanes.length > 0 && (
                              <ul
                                className="mission-rail__agents"
                                aria-label={`Agentes de ${m.title}`}
                              >
                                {missionPanes.map((pane) => {
                                  const state =
                                    paneStates.get(pane.id) ?? 'spawning';
                                  const agentKey =
                                    pane.agentName?.trim().toLocaleLowerCase();
                                  const latestAgentHandoff = agentKey
                                    ? latestHandoffByAgent.get(
                                        `${m.id}\u0000${agentKey}`,
                                      )
                                    : undefined;
                                  const outcome =
                                    latestAgentHandoff?.status === 'blocked' ||
                                    latestAgentHandoff?.status === 'failed'
                                      ? latestAgentHandoff.status
                                      : m.status === 'blocked' ||
                                          m.status === 'failed'
                                        ? m.status
                                        : undefined;
                                  const view = paneSessionView(state, {
                                    outcome,
                                  });
                                  const focused = pane.id === focusedPaneId;
                                  const role =
                                    pane.role === 'orchestrator'
                                      ? 'Maestro'
                                      : 'Especialista';
                                  return (
                                    <li key={pane.id}>
                                      <button
                                        type="button"
                                        className={`mission-rail__agent${
                                          focused
                                            ? ' mission-rail__agent--focused'
                                            : ''
                                        }`}
                                        onClick={() => focusPane(pane.id)}
                                        aria-current={
                                          focused ? 'true' : undefined
                                        }
                                        title={`${pane.agentName ?? pane.title} · ${view.tip}`}
                                        aria-label={`Focar ${pane.agentName ?? pane.title}. ${view.tip}`}
                                      >
                                        <span
                                          className={`mission-rail__agent-dot mission-rail__agent-dot--${view.mod}`}
                                          aria-hidden="true"
                                        />
                                        <span className="mission-rail__agent-name">
                                          {pane.agentName ?? pane.title}
                                        </span>
                                        <span className="mission-rail__agent-meta">
                                          <span className="mission-rail__agent-role">
                                            {role}
                                          </span>
                                          <span aria-hidden="true">·</span>
                                          <span className="mission-rail__agent-state">
                                            {view.chip}
                                          </span>
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            <div
                              className="mission-rail__row-actions"
                              role="group"
                              aria-label={`Ações da missão ${m.title}`}
                            >
                              {canPromotePlan && (
                                <button
                                  type="button"
                                  className="mission-rail__row-action mission-rail__row-action--promote"
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
                              {canBlockMission && (
                                <button
                                  type="button"
                                  className="mission-rail__row-action mission-rail__row-action--block"
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
                                className="mission-rail__row-action mission-rail__row-action--pin"
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
                              {isArchived && (
                                <button
                                  type="button"
                                  className="mission-rail__row-action mission-rail__row-action--restore"
                                  disabled={busy !== null}
                                  title="Trazer de volta para a lista"
                                  aria-label={`Desarquivar missão ${m.title}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
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
                              )}
                              {hasRemoveAction && (
                                <button
                                  type="button"
                                  className="mission-rail__row-action mission-rail__row-action--remove"
                                  disabled={busy !== null}
                                  title={
                                    isArchived
                                      ? removeMissionPrompt(m).confirmLabel
                                      : missionActionCopy(listAction).title
                                  }
                                  aria-label={`${
                                    isArchived
                                      ? 'Remover'
                                      : missionActionCopy(listAction).verb
                                  } missão ${m.title}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isArchived) {
                                      void purgeMission(m);
                                      return;
                                    }
                                    void closeOrDiscardMission(m, liveInGrid);
                                  }}
                                >
                                  <PixelIcon name="close" size={10} />
                                </button>
                              )}
                            </div>
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
