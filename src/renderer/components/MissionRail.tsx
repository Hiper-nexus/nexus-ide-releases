import { useEffect, useMemo, useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useSessionStateStore } from '../state/session-state-store';
import { livePaneIdsForMission } from '../orch/mission-reopen';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { groupMissionsForRail, statusLabel } from '../lib/mission-rail-groups';
import {
  loadCollapsedSections,
  loadPinnedMissionIds,
  saveCollapsedSections,
  savePinnedMissionIds,
  togglePinnedMissionId,
  type RailSectionId,
} from '../lib/mission-rail-prefs';
import {
  loadPinnedWorkspacePaths,
  togglePinnedWorkspacePath,
} from '../lib/workspace-rail-prefs';
import { useWorkspaceStore } from '../state/workspace-store';
import { useLayoutStore } from '../state/layout-store';
import { PixelIcon } from './PixelIcon';
import { AccountSwitcher } from './AccountSwitcher';
import { OperatorHud } from './OperatorHud';
import { askConfirm } from '../state/confirm-store';
import { AgentDropZone } from './AgentDropZone';
import type { ExternalIssue } from '../../shared/integrations-types';
import { useMissionWizardStore as useWizard } from '../state/mission-wizard-store';

/**
 * Activity Rail — mapa permanente do trabalho (Orca-style sections):
 * Fixadas · Em progresso · Na fila · Concluídas + busca + conta CLI.
 * Soft-focus when mission already live; hard reopen otherwise.
 */

export function MissionRail() {
  const missions = useOrchStore((s) => s.missions);
  const paneMissions = useOrchStore((s) => s.paneMissions);
  const handoffs = useOrchStore((s) => s.handoffs);
  const openMissionWizard = useMissionWizardStore((s) => s.openForMission);
  const openAgentic = useWizard((s) => s.openForAgentic);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const [extIssues, setExtIssues] = useState<ExternalIssue[]>([]);
  const workspace = useWorkspaceStore((s) => s.current);
  const recents = useWorkspaceStore((s) => s.recents);
  const openWorkspace = useWorkspaceStore((s) => s.open);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => loadPinnedMissionIds());
  const [pinnedWorkspaces, setPinnedWorkspaces] = useState<string[]>(() =>
    loadPinnedWorkspacePaths(),
  );
  const [collapsed, setCollapsed] = useState<RailSectionId[]>(() => loadCollapsedSections());

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
  }, [workspace?.path]);

  // Layout no dep: livePaneIds filtra panes mortos do tree — sem isso, o
  // useMemo ficava stale e missão com terminal vivo sumia do “Em progresso”.
  const layoutRoot = useLayoutStore((s) => s.root);
  const openMissionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const mid of new Set(Object.values(paneMissions))) {
      if (livePaneIdsForMission(mid).length > 0) ids.add(mid);
    }
    return ids;
    // layoutRoot: reavaliar quando o grid muda (spawn/close/split).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneMissions, layoutRoot]);

  const handoffCountByMission = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of handoffs) {
      if (!h.missionId) continue;
      map.set(h.missionId, (map.get(h.missionId) ?? 0) + 1);
    }
    return map;
  }, [handoffs]);

  const sections = useMemo(
    () =>
      groupMissionsForRail({
        missions,
        openMissionIds,
        pinnedIds,
        query,
      }),
    [missions, openMissionIds, pinnedIds, query],
  );

  const activeCount = missions.filter(
    (m) =>
      openMissionIds.has(m.id) ||
      m.status === 'running' ||
      m.status === 'blocked',
  ).length;

  function toggleSection(id: RailSectionId) {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
      saveCollapsedSections(next);
      return next;
    });
  }

  function togglePin(id: string) {
    setPinnedIds(togglePinnedMissionId(id));
  }

  async function removeMission(m: Mission, active: boolean) {
    const ok = await askConfirm({
      title: `Remover "${m.title}"?`,
      body: active
        ? 'A missão está aberta. Remover tira o registro da lista; os panes continuam abertos.'
        : 'A missão sai da lista de trabalho.',
      confirmLabel: 'Remover missão',
      danger: true,
    });
    if (!ok) return;
    setNote(null);
    void window.nexus.orch
      .removeMission(m.id)
      .then((r) => {
        if (!r.removed) setNote('Missão já não estava na lista.');
        setPinnedIds((prev) => {
          const next = prev.filter((x) => x !== m.id);
          savePinnedMissionIds(next);
          return next;
        });
      })
      .catch((cause) => {
        setNote(
          cause instanceof Error ? cause.message : 'Falha ao remover a missão.',
        );
      });
  }

  function missionMeta(mission: Mission, liveInGrid: boolean): string {
    const hands = handoffCountByMission.get(mission.id) ?? 0;
    const handBit =
      hands > 0 ? ` · ${hands} entrega${hands === 1 ? '' : 's'}` : '';
    const started = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(mission.createdAt);

    // Pending sem panes = fila de verdade.
    if (mission.status === 'pending' && !liveInGrid) {
      return `Retomar · na fila · ${started}${handBit}`;
    }

    if (liveInGrid) {
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
      if (busyCount > 0) {
        return `${busyCount} pane${busyCount === 1 ? '' : 's'} trabalhando${handBit}`;
      }
      if (spawningCount > 0) {
        return `${spawningCount} pane${spawningCount === 1 ? '' : 's'} iniciando${handBit}`;
      }
      if (ids.length > 0) {
        return `${ids.length} pane${ids.length === 1 ? '' : 's'} no grid${handBit}`;
      }
    }

    // running/blocked sem panes no grid (bind perdido ou status do agent).
    if (mission.status === 'running') {
      return `Rodando · clique para focar${handBit}`;
    }
    if (mission.status === 'blocked') {
      return `Travada · precisa de você${handBit}`;
    }
    return `Retomar · ${statusLabel(mission.status)} · ${started}${handBit}`;
  }

  function selectMission(m: Mission) {
    setBusy(m.id);
    setNote(null);
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

  const pinnedWsEntries = useMemo(() => {
    const byPath = new Map(recents.map((w) => [w.path, w]));
    if (workspace) byPath.set(workspace.path, workspace);
    return pinnedWorkspaces
      .map((p) => byPath.get(p))
      .filter((w): w is NonNullable<typeof w> => Boolean(w));
  }, [pinnedWorkspaces, recents, workspace]);

  return (
    <aside className="mission-rail activity-rail" aria-label="Trabalho">
      <header className="mission-rail__head">
        <div className="mission-rail__heading">
          <span className="mission-rail__title">Trabalho</span>
          <span className="mission-rail__summary">
            {activeCount} em progresso · {missions.length} total
          </span>
        </div>
        <button
          className="mission-rail__new"
          title="Iniciar uma nova missão (a atual fica salva aqui)"
          aria-label="Iniciar nova missão"
          onClick={openMissionWizard}
        >
          <PixelIcon name="plus" size={10} /> <span>Nova</span>
        </button>
      </header>

      <div className="activity-rail__search">
        <input
          className="activity-rail__search-input"
          type="search"
          placeholder="Filtrar missões…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filtrar missões"
        />
      </div>
      <AgentDropZone compact />

      <div className="activity-rail__body">
        {extIssues.length > 0 && (
          <section className="activity-rail__section">
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

        {(workspace || pinnedWsEntries.length > 0) && (
          <section
            className="activity-rail__section activity-rail__section--workspaces"
            aria-label="Workspaces"
          >
            <div className="activity-rail__section-head activity-rail__section-head--static">
              <span className="activity-rail__section-label">Pasta aberta</span>
            </div>
            <ul className="activity-rail__ws-list">
              {workspace && (
                <li className="activity-rail__ws-row">
                  <div
                    className="activity-rail__ws-chip activity-rail__ws-chip--current"
                    title={workspace.path}
                  >
                    <span className="activity-rail__ws-icon" aria-hidden="true">
                      ⌂
                    </span>
                    <span className="activity-rail__ws-body">
                      <span className="activity-rail__ws-name">{workspace.name}</span>
                      <span className="activity-rail__ws-badge">atual</span>
                    </span>
                    <button
                      type="button"
                      className="activity-rail__ws-pin"
                      title={
                        pinnedWorkspaces.includes(workspace.path)
                          ? 'Desafixar workspace'
                          : 'Fixar workspace'
                      }
                      onClick={() =>
                        setPinnedWorkspaces(
                          togglePinnedWorkspacePath(workspace.path),
                        )
                      }
                    >
                      <PixelIcon
                        name={
                          pinnedWorkspaces.includes(workspace.path)
                            ? 'star'
                            : 'star-outline'
                        }
                        size={10}
                      />
                    </button>
                  </div>
                </li>
              )}
              {pinnedWsEntries
                .filter((w) => w.path !== workspace?.path)
                .map((w) => (
                  <li key={w.path} className="activity-rail__ws-row">
                    <button
                      type="button"
                      className="activity-rail__ws-chip"
                      title={w.path}
                      onClick={() => void openWorkspace(w.path)}
                    >
                      <span className="activity-rail__ws-icon" aria-hidden="true">
                        ⌂
                      </span>
                      <span className="activity-rail__ws-body">
                        <span className="activity-rail__ws-name">{w.name}</span>
                        <span className="activity-rail__ws-meta">fixado · abrir</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="activity-rail__ws-pin activity-rail__ws-pin--absolute"
                      title="Desafixar workspace"
                      onClick={() =>
                        setPinnedWorkspaces(togglePinnedWorkspacePath(w.path))
                      }
                    >
                      <PixelIcon name="star" size={10} />
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        )}

        {missions.length > 0 && (
          <div
            className="activity-rail__missions-label"
            role="presentation"
          >
            Missões
          </div>
        )}

        {missions.length === 0 ? (
          <div className="activity-rail__empty">
            <p className="activity-rail__empty-title">Nenhuma missão ainda</p>
            <p className="activity-rail__empty-copy">
              Crie uma missão livre ou squad. Elas ficam aqui com status — como um
              board lateral de trabalho.
            </p>
            <button
              type="button"
              className="activity-rail__empty-cta"
              onClick={openMissionWizard}
            >
              <PixelIcon name="mission" size={12} /> Nova missão
            </button>
          </div>
        ) : (
          sections.map((section) => {
            if (section.missions.length === 0 && section.id !== 'active') return null;
            const isCollapsed = collapsed.includes(section.id);
            return (
              <section key={section.id} className="activity-rail__section">
                <button
                  type="button"
                  className="activity-rail__section-head"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="activity-rail__section-caret" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="activity-rail__section-label">{section.label}</span>
                  <span className="activity-rail__section-count">
                    {section.missions.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="mission-rail__list activity-rail__list">
                    {section.missions.length === 0 ? (
                      <li className="activity-rail__section-empty">Nada aqui</li>
                    ) : (
                      section.missions.map((m) => {
                        const liveInGrid = openMissionIds.has(m.id);
                        const inFlight =
                          liveInGrid ||
                          m.status === 'running' ||
                          m.status === 'blocked';
                        const pinned = pinnedIds.includes(m.id);
                        // Só pulsa se está no grid OU status running/blocked.
                        const dotStatus =
                          m.status === 'blocked' || m.status === 'failed'
                            ? m.status
                            : inFlight
                              ? 'running'
                              : m.status;
                        return (
                          <li key={m.id} className="mission-rail__row">
                            <button
                              className={`mission-rail__item ${liveInGrid ? 'mission-rail__item--active' : 'mission-rail__item--idle'}`}
                              disabled={busy !== null}
                              aria-current={liveInGrid ? 'true' : undefined}
                              title={
                                liveInGrid
                                  ? 'Missão aberta no grid — clique para focar'
                                  : inFlight
                                    ? 'Missão em andamento — clique para reabrir/focar panes'
                                    : 'Retomar esta missão (restaura panes + resume CLI)'
                              }
                              onClick={() => selectMission(m)}
                            >
                              <span
                                className={`mission-rail__dot mission-rail__dot--${dotStatus}`}
                              />
                              <span className="mission-rail__item-body">
                                <span className="mission-rail__item-title">
                                  {pinned && <PixelIcon name="star" size={9} />}
                                  {pinned ? ' ' : ''}
                                  {m.title}
                                </span>
                                <span className="mission-rail__item-meta">
                                  {busy === m.id
                                    ? 'Retomando…'
                                    : missionMeta(m, liveInGrid)}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="mission-rail__pin"
                              title={pinned ? 'Desafixar' : 'Fixar no topo'}
                              aria-label={pinned ? 'Desafixar missão' : 'Fixar missão'}
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
                            <button
                              className="mission-rail__remove"
                              disabled={busy !== null}
                              title="Remover esta missão da lista"
                              aria-label={`Remover missão ${m.title}`}
                              onClick={() => removeMission(m, liveInGrid)}
                            >
                              <PixelIcon name="close" size={10} />
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>

      {note && (
        <p className="mission-rail__note" role="status">
          {note}
        </p>
      )}

      <footer className="activity-rail__footer">
        {/* Gamificação mora aqui, não na zona de status da bar: XP é meta,
            não sinal operacional (P1 do critique). */}
        <OperatorHud />
        <AccountSwitcher />
      </footer>
    </aside>
  );
}
