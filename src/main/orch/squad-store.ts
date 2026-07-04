import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../persistence/db';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { squadSchema, squadsFileSchema } from '../../shared/orch-types';
import { ChangeHub, parseJsonColumn } from './store-util';

/**
 * Squad store. Squads round-trip through export/import unchanged (JSON). The
 * in-memory map is authoritative; SQLite is a write-through mirror hydrated at
 * init.
 */

interface SquadRow {
  id: string;
  name: string;
  created_at: string;
  builtin: number;
  orchestrator_instructions: string;
  native_instructions?: string;
  roster_json: string;
}

const squads = new Map<string, Squad>();
const hub = new ChangeHub();
let db: Db | null = null;

/** Candidate squads.json files migrated on first run. */
const MIGRATION_CANDIDATES = [
  path.join(os.homedir(), '.nexus', 'squads.json'),
];

/**
 * First-run migration: with an empty store, import the user's existing
 * squads.json (originals + custom squads) so the squad picker is populated on
 * day one. Same spirit as the voice audio-config migration.
 */
function migrateFromDiskIfEmpty(): void {
  if (squads.size > 0) return;
  for (const candidate of MIGRATION_CANDIDATES) {
    try {
      const json = fs.readFileSync(candidate, 'utf8');
      const count = importSquadsJson(json);
      if (count > 0) {
        console.log(`[orch] migrated ${count} squad(s) from ${candidate}`);
        return;
      }
    } catch {
      // Missing or invalid — try the next candidate.
    }
  }
}

export function initSquadStore(database: Db | null): void {
  db = database;
  squads.clear();
  if (db) {
    try {
      const rows = db.prepare('SELECT * FROM squads').all() as SquadRow[];
      for (const row of rows) {
        const candidate = {
          id: row.id,
          name: row.name,
          createdAt: row.created_at,
          builtin: row.builtin === 1,
          orchestratorInstructions: row.orchestrator_instructions,
          nativeInstructions: row.native_instructions || undefined,
          agents: parseJsonColumn<SquadAgent[]>(row.roster_json, []),
        };
        const parsed = squadSchema.safeParse(candidate);
        if (parsed.success) squads.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      console.warn('[orch] failed to hydrate squads:', err);
    }
  }
  migrateFromDiskIfEmpty();
}

function persist(squad: Squad): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO squads
         (id, name, created_at, builtin, orchestrator_instructions,
          native_instructions, roster_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      squad.id,
      squad.name,
      squad.createdAt,
      squad.builtin ? 1 : 0,
      squad.orchestratorInstructions,
      squad.nativeInstructions ?? '',
      JSON.stringify(squad.agents),
    );
  } catch (err) {
    console.warn('[orch] failed to persist squad:', err);
  }
}

export function onSquadsChange(cb: () => void): () => void {
  return hub.onChange(cb);
}

export function listSquads(): Squad[] {
  return [...squads.values()];
}

export function getSquad(id: string): Squad | null {
  return squads.get(id) ?? null;
}

/** Validate and save a squad (create or replace). Returns the saved squad. */
export function saveSquad(raw: unknown): Squad {
  const squad = squadSchema.parse(raw);
  squads.set(squad.id, squad);
  persist(squad);
  hub.emit();
  return squad;
}

export function deleteSquad(id: string): boolean {
  const existed = squads.delete(id);
  if (existed) {
    try {
      db?.prepare('DELETE FROM squads WHERE id = ?').run(id);
    } catch (err) {
      console.warn('[orch] failed to delete squad row:', err);
    }
    hub.emit();
  }
  return existed;
}

/** Find an agent across all squads by id or agentName. */
export function findAgent(
  ref: string,
): { squad: Squad; agent: SquadAgent } | null {
  for (const squad of squads.values()) {
    for (const agent of squad.agents) {
      if (agent.id === ref || agent.agentName === ref) {
        return { squad, agent };
      }
    }
  }
  return null;
}

export function listAgents(): Array<SquadAgent & { squadId: string }> {
  const out: Array<SquadAgent & { squadId: string }> = [];
  for (const squad of squads.values()) {
    for (const agent of squad.agents) out.push({ ...agent, squadId: squad.id });
  }
  return out;
}

/** Serialize all squads in the JSON file format. */
export function exportSquadsJson(): string {
  return JSON.stringify({ squads: listSquads() }, null, 2);
}

/** Import a squads file. Returns how many were saved. */
export function importSquadsJson(json: string): number {
  const parsed = squadsFileSchema.parse(JSON.parse(json));
  for (const squad of parsed.squads) {
    squads.set(squad.id, squad);
    persist(squad);
  }
  if (parsed.squads.length > 0) hub.emit();
  return parsed.squads.length;
}
