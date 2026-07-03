import type { Db } from '../persistence/db';
import type { Handoff, HandoffStatus } from '../../shared/orch-types';
import { ChangeHub, makeId, parseJsonColumn } from './store-util';

/**
 * Handoff store. Replaces Overclock's temp marker files with durable SQLite
 * rows + typed IPC (docs/ARCHITECTURE.md §E.3): no filesystem races, full
 * audit trail, and the Stop-gate queries the store instead of the disk.
 */

interface HandoffRow {
  id: string;
  mission_id: string | null;
  session_id: string | null;
  from_agent: string | null;
  status: string;
  summary: string;
  artifacts_json: string;
  delivered: number;
  created_at: number;
}

const handoffs = new Map<string, Handoff>();
const hub = new ChangeHub();
let db: Db | null = null;

export function initHandoffStore(database: Db | null): void {
  db = database;
  handoffs.clear();
  if (!db) return;
  try {
    const rows = db.prepare('SELECT * FROM handoffs').all() as HandoffRow[];
    for (const row of rows) {
      handoffs.set(row.id, {
        id: row.id,
        missionId: row.mission_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        fromAgent: row.from_agent ?? undefined,
        status: row.status as HandoffStatus,
        summary: row.summary,
        artifacts: parseJsonColumn<unknown[]>(row.artifacts_json, []),
        delivered: row.delivered === 1,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    console.warn('[orch] failed to hydrate handoffs:', err);
  }
}

function persist(handoff: Handoff): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO handoffs
         (id, mission_id, session_id, from_agent, status, summary,
          artifacts_json, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      handoff.id,
      handoff.missionId ?? null,
      handoff.sessionId ?? null,
      handoff.fromAgent ?? null,
      handoff.status,
      handoff.summary,
      JSON.stringify(handoff.artifacts),
      handoff.delivered ? 1 : 0,
      handoff.createdAt,
    );
  } catch (err) {
    console.warn('[orch] failed to persist handoff:', err);
  }
}

export function onHandoffsChange(cb: () => void): () => void {
  return hub.onChange(cb);
}

export interface SubmitHandoffInput {
  status: HandoffStatus;
  summary: string;
  artifacts?: unknown[];
  missionId?: string;
  sessionId?: string;
  fromAgent?: string;
}

export function submitHandoff(input: SubmitHandoffInput): Handoff {
  const handoff: Handoff = {
    id: makeId('handoff'),
    missionId: input.missionId,
    sessionId: input.sessionId,
    fromAgent: input.fromAgent,
    status: input.status,
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    delivered: false,
    createdAt: Date.now(),
  };
  handoffs.set(handoff.id, handoff);
  persist(handoff);
  hub.emit();
  return handoff;
}

export interface ListHandoffsFilter {
  missionId?: string;
  includeDelivered?: boolean;
}

export function listHandoffs(filter: ListHandoffsFilter = {}): Handoff[] {
  let all = [...handoffs.values()].sort((a, b) => a.createdAt - b.createdAt);
  if (filter.missionId) {
    all = all.filter((h) => h.missionId === filter.missionId);
  }
  if (!filter.includeDelivered) {
    all = all.filter((h) => !h.delivered);
  }
  return all;
}

export function markDelivered(id: string): void {
  const existing = handoffs.get(id);
  if (!existing || existing.delivered) return;
  const updated: Handoff = { ...existing, delivered: true };
  handoffs.set(id, updated);
  persist(updated);
  hub.emit();
}

/** Whether a worker session has submitted at least one handoff (Stop-gate). */
export function hasHandoffFromSession(sessionId: string): boolean {
  for (const handoff of handoffs.values()) {
    if (handoff.sessionId === sessionId) return true;
  }
  return false;
}
