import type { Db } from '../persistence/db';
import type { MissionPaneSpec } from '../../shared/orch-types';
import { makeId } from './store-util';

/**
 * Mission pane composition store — remembers which panes (adapter/model/cwd/
 * title) took part in each mission so it can be reopened from history with
 * one click, restoring the grid. Written at pane-spawn time (MCP pane_spawn
 * with a missionId) and at mission creation (the orchestrator's own pane).
 * Same in-memory-map + SQLite write-through shape as the other orch stores.
 */

interface MissionPaneRow {
  id: string;
  mission_id: string;
  adapter_id: string;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  title: string | null;
  agent_name: string | null;
  role: string;
  pane_id: string | null;
  created_at: number;
}

const specsByMission = new Map<string, MissionPaneSpec[]>();
let db: Db | null = null;

export function initMissionPaneStore(database: Db | null): void {
  db = database;
  specsByMission.clear();
  if (!db) return;
  try {
    const rows = db
      .prepare('SELECT * FROM mission_panes ORDER BY created_at ASC')
      .all() as MissionPaneRow[];
    for (const row of rows) {
      const list = specsByMission.get(row.mission_id) ?? [];
      list.push({
        id: row.id,
        missionId: row.mission_id,
        adapterId: row.adapter_id,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        cwd: row.cwd ?? undefined,
        title: row.title ?? row.adapter_id,
        agentName: row.agent_name ?? undefined,
        role: row.role === 'orchestrator' ? 'orchestrator' : 'worker',
        paneId: row.pane_id ?? undefined,
        createdAt: row.created_at,
      });
      specsByMission.set(row.mission_id, list);
    }
  } catch (err) {
    console.warn('[orch] failed to hydrate mission panes:', err);
  }
}

function persist(spec: MissionPaneSpec): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO mission_panes
         (id, mission_id, adapter_id, model, effort, cwd, title, agent_name,
          role, pane_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      spec.id,
      spec.missionId,
      spec.adapterId,
      spec.model ?? null,
      spec.effort ?? null,
      spec.cwd ?? null,
      spec.title,
      spec.agentName ?? null,
      spec.role,
      spec.paneId ?? null,
      spec.createdAt,
    );
  } catch (err) {
    console.warn('[orch] failed to persist mission pane:', err);
  }
}

export interface RecordMissionPaneInput {
  missionId: string;
  adapterId: string;
  model?: string;
  effort?: string;
  cwd?: string;
  title?: string;
  agentName?: string;
  role?: 'orchestrator' | 'worker';
  /** paneId original no layout — chave do resume direcionado no reopen. */
  paneId?: string;
}

/**
 * Record one pane of a mission's composition. Re-spawning the same agent
 * (identical adapter/model/cwd/title/role) updates the existing entry instead
 * of duplicating it, so reopen restores the composition, not the spawn log.
 */
export function recordMissionPane(input: RecordMissionPaneInput): void {
  const list = specsByMission.get(input.missionId) ?? [];
  const title = input.title ?? input.agentName ?? input.adapterId;
  const role = input.role ?? 'worker';
  const existing = list.find(
    (spec) =>
      spec.adapterId === input.adapterId &&
      spec.model === input.model &&
      spec.cwd === input.cwd &&
      spec.title === title &&
      spec.role === role,
  );
  if (existing) {
    // Registro antigo sem paneId (pré-migração) ganha a chave do resume.
    if (!existing.paneId && input.paneId) {
      existing.paneId = input.paneId;
      persist(existing);
    }
    return;
  }
  const spec: MissionPaneSpec = {
    id: makeId('mpane'),
    missionId: input.missionId,
    adapterId: input.adapterId,
    model: input.model,
    effort: input.effort,
    cwd: input.cwd,
    title,
    agentName: input.agentName,
    role,
    paneId: input.paneId,
    createdAt: Date.now(),
  };
  specsByMission.set(input.missionId, [...list, spec]);
  persist(spec);
}

/** Composition of a mission, orchestrator first then workers by spawn order. */
export function listMissionPanes(missionId: string): MissionPaneSpec[] {
  const list = specsByMission.get(missionId) ?? [];
  return [...list].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'orchestrator' ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
