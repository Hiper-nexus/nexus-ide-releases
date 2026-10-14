import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../persistence/db';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
  squadSchema,
  squadsFileSchema,
} from '../../shared/orch-types';
import { NEXUS_PLAN_SQUAD_ID } from '../../shared/builtin-squad-ids';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { BUILTIN_SQUADS, withAllowlists } from './builtin-squads';
import { ChangeHub, parseJsonColumn } from './store-util';
import {
  failedPersistenceError,
  PersistenceUnavailableError,
  readOnlyPersistenceError,
} from '../persistence/persistence-error';
import {
  snapshotSquadAuthority,
  type SquadAuthoritySnapshot,
} from './squad-authority-snapshot';
import {
  applyGuidedSquadSkillPolicy,
  withGuidedSkillDefaults,
} from './guided-squad-skills';
import { assertUniqueAgentNames, duplicateAgentName } from './squad-agent-names';
import { squadRosterUsabilityIssue } from '../../shared/squad-roster-rules';

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
  runtime_source_squad_id?: string;
  runtime_source_squad_hash?: string;
  roster_json: string;
}

const squads = new Map<string, Squad>();
const hub = new ChangeHub();
let db: Db | null = null;
let readOnly = true;
const preparedSquadSaves = new WeakSet<object>();
const preparedSquadImports = new WeakSet<object>();

export const MAX_SQUADS_IMPORT_BYTES = 1024 * 1024;
const MANAGED_SQUAD_IDS = new Set(BUILTIN_SQUADS.map((squad) => squad.id));

export interface SquadTargetExpectation {
  readonly id: string;
  readonly exists: boolean;
  readonly canonicalSha256: string | null;
}

export interface PreparedSquadSave {
  readonly squad: Squad;
  readonly snapshot: SquadAuthoritySnapshot;
  readonly canonicalJson: string;
  readonly canonicalSha256: string;
  readonly expectedTarget: SquadTargetExpectation;
}

export interface PreparedSquadsImport {
  readonly rawSha256: string;
  readonly canonicalSha256: string;
  readonly canonicalJson: string;
  readonly squads: readonly Squad[];
  readonly snapshots: readonly SquadAuthoritySnapshot[];
  readonly squadCount: number;
  readonly agentCount: number;
  readonly targetIds: readonly string[];
  readonly expectedTargets: readonly SquadTargetExpectation[];
  /** Ids do arquivo que pertencem ao app (internos/cópias de missão): ignorados. */
  readonly skippedIds: readonly string[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSquadJson(squad: Squad): string {
  return JSON.stringify(squad);
}

/**
 * Ids que nunca são catálogo do usuário: os squads internos (re-sincronizados
 * a cada boot) e as cópias seladas de missão. Nem exportam nem importam.
 */
function isAppOwnedSquadId(id: string): boolean {
  return MANAGED_SQUAD_IDS.has(id) || isMissionRuntimeSquadId(id);
}

function currentTargetExpectation(id: string): SquadTargetExpectation {
  const current = squads.get(id);
  return Object.freeze({
    id,
    exists: current !== undefined,
    canonicalSha256: current ? sha256(canonicalSquadJson(current)) : null,
  });
}

/**
 * Canonical save-time normalization. `withAllowlists` fixes tool authority;
 * `withGuidedSkillDefaults` fills the skill floor of agents that declare none
 * (absent = zero skills under governance) without ever rewriting a reviewed
 * list. Hydration reuses the agent normalization only for catalog squads
 * (`hydratedAgents`): a sealed mission runtime roster must keep the exact
 * bytes its authority hash was computed on.
 */
function normalizeUserSquad(squad: Squad): Squad {
  return {
    ...squad,
    builtin: false,
    agents: withGuidedSkillDefaults(withAllowlists(squad.agents)),
  };
}

/**
 * Hydration repair (F-1498). A catalog squad saved before the skill floor
 * existed comes back with the same agent normalization as a save — without it
 * the wizard sends no `allowedSkills` and the prepare refuses the role ("não
 * possui permissões revisadas"). A sealed mission runtime copy comes back
 * byte for byte (F-1499): its authority hash was computed on those bytes, and
 * `withAllowlists` also fills the per-CLI model default — a Codex/Grok/AGY
 * seat sealed without a model gained one after a restart and every pane of
 * that mission went "squad authority is stale".
 */
function hydratedAgents(squad: Squad): SquadAgent[] {
  if (isMissionRuntimeSquadId(squad.id)) return squad.agents;
  return withGuidedSkillDefaults(withAllowlists(squad.agents));
}

type AgentRefCandidate = { squad: Squad; agent: SquadAgent };

/**
 * F-1500: resolve a member reference in tiers — literal id (or
 * `squadId:agentId`), then literal name, and only then the trimmed
 * comparison. The first tier with any match decides, so squads saved before
 * the unique-name rule (`Dev` and `Dev ` with distinct ids, ids with spaces)
 * keep resolving exactly as they did; the trimmed fallback only finds what an
 * exact reference would not.
 */
function matchAgentRef(
  candidates: readonly AgentRefCandidate[],
  ref: string,
  options: { qualified?: boolean } = {},
): AgentRefCandidate[] {
  const qualifiedId = ({ squad, agent }: AgentRefCandidate) => `${squad.id}:${agent.id}`;
  const wanted = ref.trim();
  const tiers: Array<(candidate: AgentRefCandidate) => boolean> = [
    (candidate) =>
      candidate.agent.id === ref || (options.qualified === true && qualifiedId(candidate) === ref),
    ({ agent }) => agent.agentName === ref,
    (candidate) =>
      candidate.agent.id.trim() === wanted ||
      candidate.agent.agentName.trim() === wanted ||
      (options.qualified === true && qualifiedId(candidate).trim() === wanted),
  ];
  for (const tier of tiers) {
    const matches = candidates.filter(tier);
    if (matches.length > 0) return matches;
  }
  return [];
}

function catalogCandidates(
  include: (squad: Squad) => boolean = () => true,
): AgentRefCandidate[] {
  const candidates: AgentRefCandidate[] = [];
  for (const squad of squads.values()) {
    if (!include(squad)) continue;
    for (const agent of squad.agents) candidates.push({ squad, agent });
  }
  return candidates;
}

/**
 * Validate and normalize a main-designed squad without publishing it to the
 * reusable catalog. Agentic design is a draft operation: only the explicit
 * "Salvar configuração" action may create a global squad. Mission launch
 * seals a separate hidden runtime copy.
 */
export function normalizeEphemeralSquadCandidate(raw: unknown): Squad {
  const parsed = squadSchema.parse(raw);
  return assertManagedSavePolicy(parsed);
}

function assertManagedSavePolicy(
  parsed: Squad,
  authority: 'global' | 'mission-runtime' = 'global',
  preserveExplicitRoster = false,
): Squad {
  if (parsed.id === PET_STUDIO_SQUAD_ID) {
    // Pet Studio is app-managed and repaired to the immutable canonical
    // definition. No renderer/user bytes can influence its executable roster.
    return PET_STUDIO_SQUAD;
  }
  if (parsed.builtin || MANAGED_SQUAD_IDS.has(parsed.id)) {
    throw new Error(
      'managed built-in squads cannot be saved through the user store',
    );
  }
  const existing = squads.get(parsed.id);
  if (existing?.builtin) {
    throw new Error(
      'managed built-in squads cannot be saved through the user store',
    );
  }
  const hasRuntimeLineage =
    parsed.runtimeSourceSquadId !== undefined ||
    parsed.runtimeSourceSquadRevisionHash !== undefined;
  if (authority === 'global') {
    if (isMissionRuntimeSquadId(parsed.id)) {
      throw new Error('mission runtime squads are immutable');
    }
    if (hasRuntimeLineage) {
      throw new Error('mission runtime squad lineage is main-owned');
    }
  } else if (
    !isMissionRuntimeSquadId(parsed.id) ||
    !parsed.runtimeSourceSquadId ||
    !parsed.runtimeSourceSquadRevisionHash
  ) {
    throw new Error('mission runtime squad requires exact main-owned lineage');
  }
  assertUniqueAgentNames(parsed.agents);
  return preserveExplicitRoster
    ? { ...parsed, builtin: false }
    : normalizeUserSquad(parsed);
}

function assertExpectedTargetUnchanged(
  expected: SquadTargetExpectation,
): void {
  const current = currentTargetExpectation(expected.id);
  if (
    current.exists !== expected.exists ||
    current.canonicalSha256 !== expected.canonicalSha256
  ) {
    throw new Error(
      `squad CAS changed for ${expected.id}; prepare and review again`,
    );
  }
}

function assertPreparedSaveIntegrity(candidate: PreparedSquadSave): void {
  const canonicalJson = canonicalSquadJson(candidate.squad);
  if (
    canonicalJson !== candidate.canonicalJson ||
    sha256(canonicalJson) !== candidate.canonicalSha256 ||
    snapshotSquadAuthority(candidate.squad).hash !== candidate.snapshot.hash
  ) {
    throw new Error('prepared squad save candidate changed after review');
  }
}

function assertPreparedImportIntegrity(candidate: PreparedSquadsImport): void {
  const canonicalJson = JSON.stringify({ squads: candidate.squads }, null, 2);
  if (
    candidate.squadCount !== candidate.squads.length ||
    candidate.agentCount !==
      candidate.squads.reduce((count, squad) => count + squad.agents.length, 0) ||
    canonicalJson !== candidate.canonicalJson ||
    sha256(canonicalJson) !== candidate.canonicalSha256 ||
    candidate.targetIds.length !== candidate.squads.length ||
    candidate.expectedTargets.length !== candidate.squads.length ||
    candidate.snapshots.length !== candidate.squads.length
  ) {
    throw new Error('prepared squads import candidate changed after review');
  }
  for (const [index, squad] of candidate.squads.entries()) {
    if (
      squad.id !== candidate.targetIds[index] ||
      squad.id !== candidate.expectedTargets[index]?.id ||
      isAppOwnedSquadId(squad.id) ||
      squad.builtin ||
      snapshotSquadAuthority(squad).hash !== candidate.snapshots[index]?.hash
    ) {
      throw new Error('prepared squads import candidate changed after review');
    }
  }
}

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
      const count = importLegacySquadsJson(json);
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
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- nativo só no caminho de recuperação: abre bancos irmãos read-only e um ABI errado cai no catch e pula o candidato
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
            agents: hydratedAgents(parsed.data),
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
        runtimeSourceSquadId: row.runtime_source_squad_id || undefined,
        runtimeSourceSquadRevisionHash:
          row.runtime_source_squad_hash || undefined,
        agents: parseJsonColumn<SquadAgent[]>(row.roster_json, []),
      };
      const parsed = squadSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const healed: Squad = parsed.data.id === PET_STUDIO_SQUAD_ID
        ? PET_STUDIO_SQUAD
        : {
            ...parsed.data,
            agents: hydratedAgents(parsed.data),
          };
      hydrated.set(healed.id, healed);
      if (JSON.stringify(healed) !== JSON.stringify(parsed.data)) {
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
    // Every id in BUILTIN_SQUADS is app-managed regardless of a historical
    // row's mutable `builtin` bit. Repair old poisoned/custom takeover rows.
    persist(parsed.data, 'built-in sync');
    squads.set(parsed.data.id, parsed.data);
    refreshed += 1;
  }
  if (refreshed > 0) console.log(`[orch] built-in squads sincronizados: ${refreshed}`);
}

function ensureBuiltinsReadable(): void {
  for (const squad of BUILTIN_SQUADS) {
    const parsed = squadSchema.safeParse(squad);
    if (parsed.success) {
      squads.set(parsed.data.id, parsed.data);
    }
  }
}

function writeSquad(database: Db, squad: Squad): void {
  database.prepare(
    `INSERT OR REPLACE INTO squads
       (id, name, created_at, builtin, orchestrator_instructions,
        native_instructions, runtime_source_squad_id,
        runtime_source_squad_hash, roster_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    squad.id,
    squad.name,
    squad.createdAt,
    squad.builtin ? 1 : 0,
    squad.orchestratorInstructions,
    squad.nativeInstructions ?? '',
    squad.runtimeSourceSquadId ?? null,
    squad.runtimeSourceSquadRevisionHash ?? null,
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

/**
 * Normalize the exact executable squad and capture its current target CAS.
 * This phase is read-only: callers may show `snapshot`/`canonicalJson` in a
 * native confirmation without creating a review-to-execution gap.
 */
export function prepareSquadSave(raw: unknown): PreparedSquadSave {
  const parsed = squadSchema.parse(raw);
  const squad = assertManagedSavePolicy(parsed);
  const issue = squadRosterUsabilityIssue(squad.agents);
  if (issue) {
    throw new Error(
      `O squad "${squad.name}" ${issue}. Nenhuma missão consegue usá-lo ` +
        'assim; nada foi salvo.',
    );
  }
  const canonicalJson = canonicalSquadJson(squad);
  const candidate = Object.freeze({
    squad,
    snapshot: snapshotSquadAuthority(squad),
    canonicalJson,
    canonicalSha256: sha256(canonicalJson),
    expectedTarget: currentTargetExpectation(squad.id),
  });
  preparedSquadSaves.add(candidate);
  return candidate;
}

/**
 * Prepare a one-flow runtime copy under main-owned lineage.
 *
 * The source is resolved from the authoritative catalog by the caller. Manual
 * snapshots must preserve its semantic playbook exactly; guided snapshots may
 * retarget a generated playbook to the current goal, except that the
 * app-managed planning template can never claim lineage with substituted
 * instructions.
 */
export function prepareMissionRuntimeSquadSave(
  raw: unknown,
  sourceSquad: Squad,
  guided: boolean,
  sourceAuthority: 'catalog' | 'ephemeral' = 'catalog',
): PreparedSquadSave {
  const parsed = squadSchema.parse(raw);
  const currentSource = squads.get(sourceSquad.id);
  if (
    (sourceAuthority === 'catalog' && !currentSource) ||
    (currentSource !== undefined &&
      snapshotSquadAuthority(currentSource).hash !==
        snapshotSquadAuthority(sourceSquad).hash)
  ) {
    throw new Error('mission runtime source squad changed before persistence');
  }
  if (isMissionRuntimeSquadId(sourceSquad.id)) {
    throw new Error('mission runtime snapshots cannot be chained');
  }
  const sourceSnapshot = snapshotSquadAuthority(sourceSquad);
  if (
    parsed.runtimeSourceSquadId !== sourceSquad.id ||
    parsed.runtimeSourceSquadRevisionHash !== sourceSnapshot.hash
  ) {
    throw new Error('mission runtime squad lineage does not match its source');
  }
  const playbookMustMatch =
    !guided || sourceSquad.id === NEXUS_PLAN_SQUAD_ID;
  if (
    parsed.name !== sourceSquad.name ||
    parsed.nativeInstructions !== sourceSquad.nativeInstructions ||
    (playbookMustMatch &&
      parsed.orchestratorInstructions !== sourceSquad.orchestratorInstructions)
  ) {
    throw new Error(
      'mission runtime squad content does not match its reviewed source',
    );
  }
  // Agentic drafts may be reviewed/edited by the renderer before launch.
  // Recompute capability authority from the exact main-owned source and
  // reviewed categories so renderer/model allowlist bytes can neither widen
  // nor remove the governed grants captured by the seal. Manual/catalog
  // launches keep their explicit policies — a reviewed allowlist (including
  // `[]`) stays exactly as reviewed; only agents that declare NO skill
  // authority are filled, and the floor is derived from the main-owned source
  // roster, so renderer bytes cannot claim a role/flag they were not
  // reviewed with.
  const governed =
    guided && sourceAuthority === 'ephemeral'
      ? applyGuidedSquadSkillPolicy(parsed, {
          objective:
            `${sourceSquad.name}\n` +
            `${sourceSquad.orchestratorInstructions}\n` +
            `${sourceSquad.nativeInstructions ?? ''}`,
        })
      : {
          ...parsed,
          agents: withGuidedSkillDefaults(parsed.agents, sourceSquad.agents),
        };
  const squad = assertManagedSavePolicy(
    governed,
    'mission-runtime',
    sourceAuthority === 'ephemeral' && !guided,
  );
  const canonicalJson = canonicalSquadJson(squad);
  const candidate = Object.freeze({
    squad,
    snapshot: snapshotSquadAuthority(squad),
    canonicalJson,
    canonicalSha256: sha256(canonicalJson),
    expectedTarget: currentTargetExpectation(squad.id),
  });
  preparedSquadSaves.add(candidate);
  return candidate;
}

/** Persist a previously prepared squad exactly once, guarded by its CAS. */
export function applyPreparedSquadSave(
  candidate: PreparedSquadSave,
): Squad {
  if (!preparedSquadSaves.delete(candidate)) {
    throw new Error('squad save candidate was not prepared or was already used');
  }
  assertPreparedSaveIntegrity(candidate);
  assertExpectedTargetUnchanged(candidate.expectedTarget);
  // Re-evaluate managed ownership at the write boundary. A forged/stale
  // candidate cannot turn a later app-managed id into user-owned content.
  const exact =
    candidate.squad.id === PET_STUDIO_SQUAD_ID
      ? PET_STUDIO_SQUAD
      : candidate.squad;
  if (
    exact.id !== PET_STUDIO_SQUAD_ID &&
    (exact.builtin || MANAGED_SQUAD_IDS.has(exact.id))
  ) {
    throw new Error(
      'managed built-in squads cannot be saved through the user store',
    );
  }
  persist(exact, 'save');
  squads.set(exact.id, exact);
  hub.emit();
  return exact;
}

/**
 * Seal an immutable `mission-runtime-*` / `agentic-runtime-*` copy for approval.
 *
 * Builtins are rewritten by `syncBuiltins()` on every boot. Missions that keep
 * pointing at those live ids go `guided_plan_squad_stale` after restart. The
 * approval path must pin here so `squadRevisionHash` is computed against bytes
 * that never move again.
 */
export function pinMissionRuntimeSquad(sourceSquad: Squad): Squad {
  if (isMissionRuntimeSquadId(sourceSquad.id)) {
    const current = squads.get(sourceSquad.id);
    if (!current) {
      throw new Error('mission runtime squad is unavailable');
    }
    return current;
  }
  const liveSource = squads.get(sourceSquad.id);
  if (!liveSource) {
    throw new Error('mission runtime source squad is unavailable');
  }
  const sourceSnapshot = snapshotSquadAuthority(liveSource);
  const guided = isEngineGeneratedSquadId(liveSource.id);
  const runtimeSquad: Squad = {
    ...liveSource,
    id: `${guided ? 'agentic' : 'mission'}-runtime-${randomUUID()}`,
    createdAt: String(Date.now()),
    builtin: false,
    runtimeSourceSquadId: liveSource.id,
    runtimeSourceSquadRevisionHash: sourceSnapshot.hash,
    agents: liveSource.agents.map((agent) => ({ ...agent })),
  };
  if (!isMissionRuntimeSquadId(runtimeSquad.id)) {
    throw new Error('main generated an invalid mission runtime squad id');
  }
  return applyPreparedSquadSave(
    prepareMissionRuntimeSquadSave(
      runtimeSquad,
      liveSource,
      guided,
      'catalog',
    ),
  );
}

/** Validate, normalize and synchronously save a squad. */
export function saveSquad(raw: unknown): Squad {
  return applyPreparedSquadSave(prepareSquadSave(raw));
}

export function deleteSquad(id: string): boolean {
  if (MANAGED_SQUAD_IDS.has(id) || isMissionRuntimeSquadId(id)) return false;
  const current = squads.get(id);
  if (!current || current.builtin) return false;
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
/**
 * Main-only rollback for a runtime squad whose owning preparation row was
 * removed by exact CAS before review authority was fenced. The expected hash
 * prevents a stale preparation from deleting a later squad revision. Callers
 * must prove the owning mission no longer exists before invoking this.
 */
export function discardMissionRuntimeSquadIfUnchanged(
  rawId: string,
  rawExpectedHash: string,
): boolean {
  const id = z.string().min(1).max(128).parse(rawId);
  const expectedHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(rawExpectedHash);
  if (!isMissionRuntimeSquadId(id)) return false;
  const current = squads.get(id);
  if (
    !current ||
    current.builtin ||
    snapshotSquadAuthority(current).hash !== expectedHash
  ) {
    return false;
  }
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


/**
 * The exact set of provider CLIs a squad's roster authorizes. Empty when the
 * squad id is unknown to the store. This binds the agentic route/spawn path to
 * the mission's sealed squad: a route is only reserved for — and an ad-hoc
 * worker (no agentName) may only run on — a CLI the squad roster contains, so
 * the agentic path can no longer ignore the saved squad. An empty set means the
 * squad is unresolvable and the gate stays fail-open (no membership to judge).
 */
export function squadRoutableCliIds(squadId: string): ReadonlySet<string> {
  const squad = squads.get(squadId);
  if (!squad) return new Set();
  return new Set(squad.agents.map((agent) => agent.cli));
}

/** Find an agent across all squads by id or agentName. */
export function findAgent(
  ref: string,
): { squad: Squad; agent: SquadAgent } | null {
  return matchAgentRef(catalogCandidates(), ref)[0] ?? null;
}

export function findAgentInSquad(
  squadId: string,
  ref: string,
): { squad: Squad; agent: SquadAgent } | null {
  const squad = getSquad(squadId);
  if (!squad) return null;
  const matches = matchAgentRef(
    squad.agents.map((agent) => ({ squad, agent })),
    ref,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolve um agente pelo nome em QUALQUER squad, para quando não há missão que
 * fixe o squad. Ambíguo (mesmo nome em squads diferentes) devolve null: melhor
 * pedir o nome exato do que spawnar o agente errado.
 */
export function findAgentInAnySquad(
  ref: string,
): { squad: Squad; agent: SquadAgent } | null {
  const matches = matchAgentRef(catalogCandidates(), ref);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * F-1314: missão de agente livre (sem squad) também nomeia agente do catálogo.
 * Só squads salvos: o snapshot `*-runtime-*` é evidência da missão que o
 * criou, não catálogo. Aceita `squadId:agentId`; nome desconhecido ou ambíguo
 * recusa — o ambíguo listando essas opções.
 */
export function requireCatalogAgent(
  ref: string,
): { squad: Squad; agent: SquadAgent } {
  const matches = matchAgentRef(
    catalogCandidates((squad) => !isMissionRuntimeSquadId(squad.id)),
    ref,
    { qualified: true },
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `unknown squad agent: ${ref} — nenhum squad salvo (Configurações › Squads) ` +
        'tem esse agente; ou abra o pane direto passando adapterId',
    );
  }
  throw new Error(
    `agente ambíguo: ${ref} existe em mais de um squad salvo — use agentName ` +
      matches.map(({ squad, agent }) => `"${squad.id}:${agent.id}"`).join(' ou '),
  );
}

export function listAgents(): Array<SquadAgent & { squadId: string }> {
  const out: Array<SquadAgent & { squadId: string }> = [];
  for (const squad of squads.values()) {
    for (const agent of squad.agents) out.push({ ...agent, squadId: squad.id });
  }
  return out;
}

/** Serialize the user's own squads in the JSON file format. */
export function exportSquadsJson(): string {
  // Runtime snapshots are immutable mission evidence, not reusable catalog
  // configuration. Keep them available to mission bootstrap/history while
  // excluding them from the user's normal squads export. F-1502: the managed
  // built-ins ship with every install and the import refuses their ids, so
  // exporting them made the app's own file unimportable on another PC.
  return JSON.stringify(
    {
      squads: listSquads().filter(
        (squad) => !squad.builtin && !isAppOwnedSquadId(squad.id),
      ),
    },
    null,
    2,
  );
}

/**
 * Parse and normalize an import without mutating SQLite or the read cache.
 * Raw and canonical hashes let the IPC boundary bind both the selected bytes
 * and the exact executable definitions shown to the operator.
 */
export function prepareSquadsImport(
  raw: string | Buffer,
): PreparedSquadsImport {
  return prepareSquadsImportCandidate(raw, true);
}

function prepareSquadsImportCandidate(
  raw: string | Buffer,
  requireUsableRoster: boolean,
): PreparedSquadsImport {
  const byteLength =
    typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (byteLength > MAX_SQUADS_IMPORT_BYTES) {
    throw new Error('squads import exceeds the 1 MiB limit');
  }
  const rawText =
    typeof raw === 'string'
      ? raw
      : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const parsed = squadsFileSchema.parse(JSON.parse(rawText));
  // F-1502: arquivos de versões anteriores trazem os internos (e cópias de
  // missão). Esses ids continuam reservados — nunca sobrescrevem o app —, mas
  // são ignorados com aviso em vez de recusar os squads do usuário junto.
  const skippedIds = parsed.squads
    .filter((squad) => isAppOwnedSquadId(squad.id))
    .map((squad) => squad.id);
  const importedSquads = parsed.squads
    .filter((squad) => !isAppOwnedSquadId(squad.id))
    .map(normalizeUserSquad);
  // F-1503: a mesma regra do salvar e do prepare (coordenador, teto e nome de
  // integrante único, F-1500) — o arquivo é atômico, então um squad que
  // nenhuma missão usa recusa a importação inteira, nomeando cada um.
  const unusable = requireUsableRoster
    ? importedSquads.flatMap((squad) => {
        const duplicate = duplicateAgentName(squad.agents);
        const issues = [
          squadRosterUsabilityIssue(squad.agents),
          duplicate === null
            ? null
            : `tem mais de um integrante chamado \`${duplicate}\``,
        ].filter((issue): issue is string => issue !== null);
        return issues.length > 0
          ? [`O squad "${squad.name}" (${squad.id}) ${issues.join('; ')}.`]
          : [];
      })
    : [];
  if (unusable.length > 0) {
    throw new Error(
      `${unusable.join(' ')} Nenhuma missão consegue ` +
        `${unusable.length === 1 ? 'usá-lo' : 'usá-los'} assim; nada foi ` +
        'importado. Corrija o arquivo e importe de novo.',
    );
  }
  const canonicalJson = JSON.stringify({ squads: importedSquads }, null, 2);
  const candidate = Object.freeze({
    rawSha256: sha256(
      typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw,
    ),
    canonicalSha256: sha256(canonicalJson),
    canonicalJson,
    squads: Object.freeze(importedSquads),
    snapshots: Object.freeze(importedSquads.map(snapshotSquadAuthority)),
    squadCount: importedSquads.length,
    agentCount: importedSquads.reduce(
      (count, squad) => count + squad.agents.length,
      0,
    ),
    targetIds: Object.freeze(importedSquads.map((squad) => squad.id)),
    expectedTargets: Object.freeze(
      importedSquads.map((squad) => currentTargetExpectation(squad.id)),
    ),
    skippedIds: Object.freeze(skippedIds),
  });
  preparedSquadImports.add(candidate);
  return candidate;
}

/** CAS-check and atomically apply every squad in a prepared import. */
export function applyPreparedSquadsImport(
  candidate: PreparedSquadsImport,
): number {
  if (!preparedSquadImports.delete(candidate)) {
    throw new Error(
      'squads import candidate was not prepared or was already used',
    );
  }
  assertPreparedImportIntegrity(candidate);
  for (const expected of candidate.expectedTargets) {
    assertExpectedTargetUnchanged(expected);
  }
  if (candidate.squads.length === 0) return 0;
  const database = requireWritableDb();
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const squad of candidate.squads) writeSquad(database, squad);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The original persistence failure remains authoritative.
    }
    failPersistence('import', error);
  }

  for (const squad of candidate.squads) squads.set(squad.id, squad);
  hub.emit();
  return candidate.squads.length;
}

/** Compatibility funnel for trusted internal callers and first-run migration. */
export function importSquadsJson(json: string): number {
  return applyPreparedSquadsImport(prepareSquadsImport(json));
}

/**
 * Trusted first-run migration only. Old exports commonly contain copies of
 * Nexus managed squads; ignore those rows and recover the remaining custom
 * definitions through the same normalized, atomic public apply path. The
 * F-1503 roster rule is not applied: recovery keeps what the user had, and
 * the editor is where an unusable roster gets fixed.
 */
export function importLegacySquadsJson(json: string): number {
  if (Buffer.byteLength(json, 'utf8') > MAX_SQUADS_IMPORT_BYTES) {
    throw new Error('legacy squads import exceeds the 1 MiB limit');
  }
  const parsed = squadsFileSchema.parse(JSON.parse(json));
  const customs = parsed.squads.filter(
    (squad) => !MANAGED_SQUAD_IDS.has(squad.id),
  );
  return applyPreparedSquadsImport(
    prepareSquadsImportCandidate(JSON.stringify({ squads: customs }), false),
  );
}
