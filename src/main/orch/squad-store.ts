import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../persistence/db';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { squadSchema, squadsFileSchema } from '../../shared/orch-types';
import { BUILTIN_SQUADS, withAllowlists } from './builtin-squads';
import { ChangeHub, parseJsonColumn } from './store-util';
import {
  failedPersistenceError,
  PersistenceUnavailableError,
  readOnlyPersistenceError,
} from '../persistence/persistence-error';

/**
 * Squad store. SQLite is authoritative. The in-memory map is a read cache that
 * is only changed after a write succeeds; when SQLite is unavailable it stays
 * readable but every mutation fails closed.
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
let readOnly = true;

function replaceSquadCache(next: ReadonlyMap<string, Squad>): void {
  squads.clear();
  for (const [id, squad] of next) squads.set(id, squad);
}

function requireWritableDb(): Db {
  if (!db || readOnly) throw readOnlyPersistenceError('squad');
  return db;
}

function failPersistence(operation: string, error: unknown): never {
  readOnly = true;
  db = null;
  throw failedPersistenceError('squad', operation, error);
}

export function isSquadStoreReadOnly(): boolean {
  return readOnly;
}

/** Candidate squads.json files migrated on first run. */
const MIGRATION_CANDIDATES = [
  path.join(os.homedir(), '.nexus', 'squads.json'),
];

const SIBLING_DB_CANDIDATES = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Electron', 'nexus.db'),
  path.join(os.homedir(), 'Library', 'Application Support', 'NexusIDE', 'nexus.db'),
];

interface LegacySquadRow {
  id: string;
  name: string;
  created_at: string;
  builtin: number;
  orchestrator_instructions: string;
  roster_json: string;
}

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
    } catch (error) {
      if (error instanceof PersistenceUnavailableError) throw error;
      // Missing or invalid — try the next candidate.
    }
  }
}

function recoverMissingUserSquadsFromSiblingDbs(): void {
  if (process.env.VITEST) return;
  let recovered = 0;
  for (const candidate of SIBLING_DB_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3') as new (
        file: string,
        opts?: { readonly?: boolean; fileMustExist?: boolean },
      ) => Db;
      const source = new Database(candidate, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rows = source
          .prepare(
            `SELECT id, name, created_at, builtin,
                    orchestrator_instructions, roster_json
               FROM squads
              WHERE builtin = 0`,
          )
          .all() as LegacySquadRow[];
        for (const row of rows) {
          if (squads.has(row.id)) continue;
          const parsed = squadSchema.safeParse({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            builtin: false,
            orchestratorInstructions: row.orchestrator_instructions,
            agents: parseJsonColumn<SquadAgent[]>(row.roster_json, []),
          });
          if (!parsed.success) continue;
          const squad: Squad = {
            ...parsed.data,
            agents: withAllowlists(parsed.data.agents),
          };
          persist(squad, 'sibling recovery');
          squads.set(squad.id, squad);
          recovered += 1;
        }
      } finally {
        source.close();
      }
    } catch (error) {
      if (error instanceof PersistenceUnavailableError) throw error;
      // Best-effort profile recovery; normal DB hydration remains authoritative.
    }
  }
  if (recovered > 0) {
    console.log(`[orch] recovered ${recovered} custom squad(s) from sibling profile DBs`);
  }
}

export function initSquadStore(database: Db | null): void {
  db = database;
  readOnly = true;
  if (!database) {
    ensureBuiltinsReadable();
    return;
  }

  const hydrated = new Map<string, Squad>();
  const repairs: Squad[] = [];
  try {
    const rows = database.prepare('SELECT * FROM squads').all() as SquadRow[];
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
      if (!parsed.success) continue;
      const healed: Squad = {
        ...parsed.data,
        agents: withAllowlists(parsed.data.agents),
      };
      hydrated.set(healed.id, healed);
      if (JSON.stringify(healed.agents) !== JSON.stringify(parsed.data.agents)) {
        repairs.push(healed);
      }
    }
  } catch (error) {
    console.warn('[orch] failed to hydrate squads; using read-only cache:', error);
    db = null;
    ensureBuiltinsReadable();
    return;
  }

  replaceSquadCache(hydrated);
  readOnly = false;
  try {
    for (const squad of repairs) persist(squad, 'hydration repair');
    recoverMissingUserSquadsFromSiblingDbs();
    migrateFromDiskIfEmpty();
    syncBuiltins();
  } catch (error) {
    console.warn('[orch] squad persistence unavailable; store is read-only:', error);
    ensureBuiltinsReadable();
  }
}

/** Keep managed built-ins current without touching user-owned squads. */
function syncBuiltins(): void {
  // Builtin squads são gerenciados pelo app: sempre re-sincronizados no boot
  // (rosters/instruções evoluem com o produto). Squads do usuário (ids
  // próprios / builtin=false) nunca são tocados.
  let refreshed = 0;
  for (const squad of BUILTIN_SQUADS) {
    const parsed = squadSchema.safeParse(squad);
    if (!parsed.success) continue;
    const existing = squads.get(parsed.data.id);
    if (!existing || existing.builtin) {
      persist(parsed.data, 'built-in sync');
      squads.set(parsed.data.id, parsed.data);
      refreshed += 1;
    }
  }
  if (refreshed > 0) console.log(`[orch] built-in squads sincronizados: ${refreshed}`);
}

function ensureBuiltinsReadable(): void {
  for (const squad of BUILTIN_SQUADS) {
    const parsed = squadSchema.safeParse(squad);
    if (parsed.success && !squads.has(parsed.data.id)) {
      squads.set(parsed.data.id, parsed.data);
    }
  }
}

function writeSquad(database: Db, squad: Squad): void {
  database.prepare(
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
}

function persist(squad: Squad, operation: string): void {
  const database = requireWritableDb();
  try {
    writeSquad(database, squad);
  } catch (error) {
    failPersistence(operation, error);
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
  const parsed = squadSchema.parse(raw);
  // Normalize workers' allowlists with the same canonical rule the built-ins
  // use (withAllowlists): every persisted worker gets a non-null `allowedTools`
  // so it passes the wizard's fire-gate (validateWorkerToolScopes). Custom and
  // architect-generated squads (designSquad → saveSquad) both funnel here.
  const squad: Squad = { ...parsed, agents: withAllowlists(parsed.agents) };
  persist(squad, 'save');
  squads.set(squad.id, squad);
  hub.emit();
  return squad;
}

export function deleteSquad(id: string): boolean {
  if (!squads.has(id)) return false;
  const database = requireWritableDb();
  try {
    database.prepare('DELETE FROM squads WHERE id = ?').run(id);
  } catch (error) {
    failPersistence('delete', error);
  }
  squads.delete(id);
  hub.emit();
  return true;
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
  const importedSquads = parsed.squads.map(
    (squad): Squad => ({
      ...squad,
      agents: withAllowlists(squad.agents),
    }),
  );
  if (importedSquads.length === 0) return 0;

  const database = requireWritableDb();
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const squad of importedSquads) writeSquad(database, squad);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The original persistence failure remains authoritative.
    }
    failPersistence('import', error);
  }

  for (const squad of importedSquads) squads.set(squad.id, squad);
  hub.emit();
  return importedSquads.length;
}
