import type { Db } from '../persistence/db';
import type { Mission, MissionPatch, MissionStatus } from '../../shared/orch-types';
import { ChangeHub, makeId, parseJsonColumn } from './store-util';

/**
 * Mission store — create/get/list/set_status backing the nexus_mission_* MCP
 * tools. The orchestratorSessionId (the PTY session that created the mission)
 * is the delivery target for handoffs once it goes idle.
 */

interface MissionRow {
  id: string;
  title: string;
  description: string;
  status: string;
  squad_id: string | null;
  milestones_json: string;
  orch_session_id: string | null;
  created_at: number;
  updated_at: number;
}

const missions = new Map<string, Mission>();
const hub = new ChangeHub();
let db: Db | null = null;

export function initMissionStore(database: Db | null): void {
  db = database;
  missions.clear();
  if (!db) return;
  try {
    const rows = db.prepare('SELECT * FROM missions').all() as MissionRow[];
    for (const row of rows) {
      missions.set(row.id, {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status as MissionStatus,
        squadId: row.squad_id ?? undefined,
        milestones: parseJsonColumn<string[]>(row.milestones_json, []),
        orchestratorSessionId: row.orch_session_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  } catch (err) {
    console.warn('[orch] failed to hydrate missions:', err);
  }
}

function persist(mission: Mission): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO missions
         (id, title, description, status, squad_id, milestones_json,
          orch_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mission.id,
      mission.title,
      mission.description,
      mission.status,
      mission.squadId ?? null,
      JSON.stringify(mission.milestones),
      mission.orchestratorSessionId ?? null,
      mission.createdAt,
      mission.updatedAt,
    );
  } catch (err) {
    console.warn('[orch] failed to persist mission:', err);
  }
}

export function onMissionsChange(cb: () => void): () => void {
  return hub.onChange(cb);
}

export interface CreateMissionInput {
  title: string;
  description?: string;
  squadId?: string;
  milestones?: string[];
  orchestratorSessionId?: string;
}

export function createMission(input: CreateMissionInput): Mission {
  const now = Date.now();
  const mission: Mission = {
    id: makeId('mission'),
    title: input.title,
    description: input.description ?? '',
    status: 'pending',
    squadId: input.squadId,
    milestones: input.milestones ?? [],
    orchestratorSessionId: input.orchestratorSessionId,
    createdAt: now,
    updatedAt: now,
  };
  missions.set(mission.id, mission);
  persist(mission);
  hub.emit();
  return mission;
}

export function getMission(id: string): Mission | null {
  return missions.get(id) ?? null;
}

export function listMissions(status?: MissionStatus): Mission[] {
  const all = [...missions.values()].sort((a, b) => b.createdAt - a.createdAt);
  return status ? all.filter((m) => m.status === status) : all;
}

/**
 * Point handoff delivery at a NEW orchestrator session — used when a mission
 * is reopened from history and its original session is long gone.
 */
export function setMissionOrchestratorSession(
  id: string,
  sessionId: string,
): Mission | null {
  const existing = missions.get(id);
  if (!existing) return null;
  const updated: Mission = {
    ...existing,
    orchestratorSessionId: sessionId,
    updatedAt: Date.now(),
  };
  missions.set(id, updated);
  persist(updated);
  hub.emit();
  return updated;
}

/**
 * Renderer-facing patch mutator — applies any subset of title/description/
 * status/milestones. Returns null when the mission doesn't exist.
 */
export function updateMission(id: string, patch: MissionPatch): Mission | null {
  const existing = missions.get(id);
  if (!existing) return null;
  const updated: Mission = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.milestones !== undefined ? { milestones: patch.milestones } : {}),
    updatedAt: Date.now(),
  };
  missions.set(id, updated);
  persist(updated);
  hub.emit();
  return updated;
}

export function setMissionStatus(
  id: string,
  status: MissionStatus,
): Mission | null {
  const existing = missions.get(id);
  if (!existing) return null;
  const updated: Mission = { ...existing, status, updatedAt: Date.now() };
  missions.set(id, updated);
  persist(updated);
  hub.emit();
  return updated;
}
