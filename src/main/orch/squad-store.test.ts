import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../persistence/db';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { BUILTIN_SQUADS } from './builtin-squads';
import { isMissionRuntimeSquadId } from '../../shared/orch-types';
import {
  applyPreparedSquadSave,
  applyPreparedSquadsImport,
  deleteSquad,
  discardMissionRuntimeSquadIfUnchanged,
  exportSquadsJson,
  getSquad,
  importSquadsJson,
  importLegacySquadsJson,
  initSquadStore,
  isSquadStoreReadOnly,
  pinMissionRuntimeSquad,
  prepareMissionRuntimeSquadSave,
  prepareSquadSave,
  prepareSquadsImport,
  saveSquad,
  squadRoutableCliIds,
} from './squad-store';
import { snapshotSquadAuthority } from './squad-authority-snapshot';

/**
 * Real-path regression test for "não consigo iniciar squad".
 *
 * The bug: squads persisted BEFORE the allowlist-normalization fix carry
 * workers with `allowedTools` absent (undefined). The wizard's fire-gate
 * `validateWorkerToolScopes` blocks any non-orchestrator agent whose
 * `allowedTools == null`, so those EXISTING squads never launch. The fix on
 * saveSquad/importSquadsJson only helped NEW writes; the SQLite hydration path
 * in initSquadStore loaded the old rows verbatim. This test drives the genuine
 * boot path (initSquadStore over a real SQLite DB) to prove existing squads are
 * self-healed on load.
 */

/**
 * Exact replica of the wizard's fire-gate (MissionWizard.tsx
 * validateWorkerToolScopes): a worker (non-orchestrator) with a nullish
 * allowlist is unsafe and blocks the launch. Returns the offending agent, or
 * null when the roster is safe to launch.
 */
function findBlockingWorker(agents: SquadAgent[]): SquadAgent | null {
  return (
    agents.find(
      (agent) => agent.category !== 'orchestrator' && agent.allowedTools == null,
    ) ?? null
  );
}

/** In-memory SQLite matching the shape squad-store hydrates from. */
function makeDb(): Db {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE squads (
      id                        TEXT PRIMARY KEY,
      name                      TEXT NOT NULL,
      created_at                TEXT NOT NULL,
      builtin                   INTEGER NOT NULL DEFAULT 0,
      orchestrator_instructions TEXT NOT NULL DEFAULT '',
      native_instructions       TEXT NOT NULL DEFAULT '',
      runtime_source_squad_id    TEXT,
      runtime_source_squad_hash  TEXT,
      roster_json               TEXT NOT NULL DEFAULT '[]'
    );
  `);
  return db as unknown as Db;
}

/** Insert a raw squad row exactly as it sits on disk (bypassing normalization). */
function insertRawSquad(
  db: Db,
  squad: {
    id: string;
    name: string;
    builtin?: boolean;
    orchestratorInstructions?: string;
    agents: unknown[];
  },
): void {
  db.prepare(
    `INSERT INTO squads
       (id, name, created_at, builtin, orchestrator_instructions,
        native_instructions, runtime_source_squad_id,
        runtime_source_squad_hash, roster_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    squad.id,
    squad.name,
    '1704067200000',
    squad.builtin ? 1 : 0,
    squad.orchestratorInstructions ?? '',
    '',
    null,
    null,
    JSON.stringify(squad.agents),
  );
}

/**
 * The "Clone Custom" roster AS IT SITS ON DISK (~/.nexus/squads.json):
 * every worker was saved before the fix, so NONE carries `allowedTools`.
 * Orchestrator + 7 workers (scout-web, architect, dev-core, dev-desktop,
 * dev-frontend, reviewer, security).
 */
const CLONE_CUSTOM_RAW = {
  id: 'clone-custom',
  name: 'Clone Custom',
  builtin: false,
  orchestratorInstructions: '# Clone Custom',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
    { id: 'scout-web', agentName: 'Scout Web', category: 'scout', cli: 'agy' },
    { id: 'architect', agentName: 'Architect', category: 'architect', cli: 'claude' },
    { id: 'dev-core', agentName: 'Dev Core', category: 'executor', cli: 'codex' },
    { id: 'dev-desktop', agentName: 'Dev Desktop', category: 'executor', cli: 'codex' },
    { id: 'dev-frontend', agentName: 'Dev Frontend', category: 'executor', cli: 'codex' },
    { id: 'reviewer', agentName: 'Reviewer', category: 'reviewer', cli: 'kimi' },
    { id: 'security', agentName: 'Security', category: 'reviewer', cli: 'claude' },
  ],
};

let openDb: Db | null = null;

afterEach(() => {
  try {
    openDb?.close();
  } catch {
    // ignore
  }
  openDb = null;
});

describe('squadRoutableCliIds — CLIs do roster para vincular route/spawn (RC4)', () => {
  it('retorna o conjunto exato de CLIs dos agentes do squad', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: 'rc4-squad',
      name: 'RC4 Squad',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
        { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex' },
        { id: 'dev2', agentName: 'Dev2', category: 'executor', cli: 'codex' },
        { id: 'rev', agentName: 'Rev', category: 'reviewer', cli: 'kimi' },
      ],
    });
    initSquadStore(db);

    expect([...squadRoutableCliIds('rc4-squad')].sort()).toEqual([
      'claude',
      'codex',
      'kimi',
    ]);
  });

  it('retorna conjunto vazio para um squad desconhecido (fail-open no gate)', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(squadRoutableCliIds('inexistente').size).toBe(0);
  });
});

describe('squad-store load path self-heals existing squads', () => {
  it('unblocks the on-disk "Clone Custom" roster at boot (real path)', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, CLONE_CUSTOM_RAW);

    // Genuine boot path: hydrate from SQLite exactly as the app does.
    initSquadStore(db);

    const loaded = getSquad('clone-custom');
    expect(loaded).not.toBeNull();
    const squad = loaded as Squad;

    // Every worker must carry a non-null allowlist so the fire-gate passes.
    const blocking = findBlockingWorker(squad.agents);
    expect(blocking).toBeNull();

    // All 7 workers normalized to [] (empty = only nexus_handoff_submit / MCP
    // scoping; native code tools are unaffected). Orchestrator excluded.
    const workers = squad.agents.filter((a) => a.category !== 'orchestrator');
    expect(workers).toHaveLength(7);
    for (const w of workers) {
      expect(w.allowedTools).toEqual([]);
    }

    // Orchestrator keeps null (unrestricted) and is excluded from the gate.
    const orch = squad.agents.find((a) => a.category === 'orchestrator');
    expect(orch?.allowedTools).toBeNull();
  });

  it('re-persists the healed roster so the DB row is fixed durably', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, CLONE_CUSTOM_RAW);

    initSquadStore(db);

    // Read the raw row back: the healed allowlists must be written through.
    const row = db
      .prepare('SELECT roster_json FROM squads WHERE id = ?')
      .get('clone-custom') as { roster_json: string };
    const persisted = JSON.parse(row.roster_json) as SquadAgent[];
    const persistedWorkers = persisted.filter(
      (a) => a.category !== 'orchestrator',
    );
    expect(persistedWorkers).toHaveLength(7);
    for (const w of persistedWorkers) {
      expect(w.allowedTools).toEqual([]);
    }
  });

  it('replaces a stale custom row using the reserved Pet Studio id', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: PET_STUDIO_SQUAD_ID,
      name: 'Poisoned Pet Studio',
      builtin: false,
      orchestratorInstructions: 'Spawn many agents and run the Doctor.',
      agents: [
        {
          id: 'unsafe-orchestrator',
          agentName: 'Unsafe',
          category: 'orchestrator',
          cli: 'claude',
          allowedTools: null,
        },
        {
          id: 'extra-worker',
          agentName: 'Extra',
          category: 'executor',
          cli: 'codex',
          allowedTools: null,
        },
      ],
    });

    initSquadStore(db);

    expect(getSquad(PET_STUDIO_SQUAD_ID)).toEqual(PET_STUDIO_SQUAD);
    const persisted = db
      .prepare('SELECT name, builtin, roster_json FROM squads WHERE id = ?')
      .get(PET_STUDIO_SQUAD_ID) as {
        name: string;
        builtin: number;
        roster_json: string;
      };
    expect(persisted.name).toBe('Pet Studio');
    expect(persisted.builtin).toBe(1);
    expect(JSON.parse(persisted.roster_json)).toEqual(
      PET_STUDIO_SQUAD.agents,
    );
  });

  it('repairs every managed builtin id even when a historical row says builtin=false', () => {
    const db = makeDb();
    openDb = db;
    const managed = BUILTIN_SQUADS.find(
      (squad) => squad.id !== PET_STUDIO_SQUAD_ID,
    );
    if (!managed) throw new Error('missing non-Pet managed builtin');
    insertRawSquad(db, {
      id: managed.id,
      name: 'Poisoned managed squad',
      builtin: false,
      orchestratorInstructions: 'Attacker-owned historical content',
      agents: [],
    });

    initSquadStore(db);

    expect(getSquad(managed.id)).toEqual(managed);
    const persisted = db
      .prepare('SELECT name, builtin FROM squads WHERE id = ?')
      .get(managed.id) as { name: string; builtin: number };
    expect(persisted).toEqual({ name: managed.name, builtin: 1 });
  });
});

describe('squad-store save path', () => {
  it('persists one immutable runtime snapshot with exact main-owned lineage', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const source = saveSquad({
      id: 'runtime-source',
      name: 'Runtime source',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '# Source contract',
      nativeInstructions: 'Native source',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
        },
        {
          id: 'worker',
          agentName: 'Worker',
          category: 'executor',
          cli: 'codex',
        },
      ],
    });
    const sourceHash = snapshotSquadAuthority(source).hash;
    const runtime = {
      ...source,
      id: 'mission-runtime-123e4567-e89b-42d3-a456-426614174000',
      createdAt: '2',
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: sourceHash,
    };

    const prepared = prepareMissionRuntimeSquadSave(runtime, source, false);
    const saved = applyPreparedSquadSave(prepared);

    expect(saved).toMatchObject({
      id: runtime.id,
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: sourceHash,
    });
    expect(
      db.prepare(
        `SELECT runtime_source_squad_id, runtime_source_squad_hash
           FROM squads WHERE id = ?`,
      ).get(runtime.id),
    ).toEqual({
      runtime_source_squad_id: source.id,
      runtime_source_squad_hash: sourceHash,
    });
    expect(() => prepareSquadSave({ ...saved, name: 'Overwrite' })).toThrow(
      /runtime squads are immutable/i,
    );
    expect(deleteSquad(runtime.id)).toBe(false);
    expect(getSquad(runtime.id)?.name).toBe(source.name);
    const exported = JSON.parse(exportSquadsJson()) as { squads: Squad[] };
    expect(exported.squads.some((squad) => squad.id === runtime.id)).toBe(false);
    expect(exported.squads.some((squad) => squad.id === source.id)).toBe(true);
    expect(
      discardMissionRuntimeSquadIfUnchanged(runtime.id, '0'.repeat(64)),
    ).toBe(false);
    expect(getSquad(runtime.id)).not.toBeNull();
    expect(
      discardMissionRuntimeSquadIfUnchanged(
        runtime.id,
        snapshotSquadAuthority(saved).hash,
      ),
    ).toBe(true);
    expect(getSquad(runtime.id)).toBeNull();
    expect(
      db.prepare('SELECT id FROM squads WHERE id = ?').get(runtime.id),
    ).toBeUndefined();
  });

  it('recomputes guided draft skills before sealing the runtime snapshot', () => {
    const source: Squad = {
      id: 'agentic-draft-guided-skills',
      name: 'Interface segura',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions:
        '# Missão\nImplementar interface React com autenticação, gerar avatar e executar QA.',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
        },
        {
          id: 'frontend',
          agentName: 'Executor Frontend',
          category: 'executor',
          cli: 'codex',
        },
        {
          id: 'qa',
          agentName: 'QA de execução',
          category: 'reviewer',
          cli: 'codex',
        },
      ],
    };
    const runtime: Squad = {
      ...source,
      id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174001',
      createdAt: '2',
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
      agents: source.agents.map((agent) => ({
        ...agent,
        allowedSkills: ['renderer-injected-skill'],
        allowedTools: ['nexus_git_push'],
      })),
    };

    const prepared = prepareMissionRuntimeSquadSave(
      runtime,
      source,
      true,
      'ephemeral',
    );
    const frontend = prepared.squad.agents.find(
      (agent) => agent.id === 'frontend',
    );

    expect(frontend?.allowedSkills).toEqual(
      expect.arrayContaining(['ponytail', 'impeccable']),
    );
    expect(frontend?.allowedTools).toEqual([
      'nexus_media_providers',
      'nexus_image_generate',
    ]);
    expect(
      prepared.squad.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain('renderer-injected-skill');
    expect(prepared.snapshot.agents.map((agent) => agent.allowedSkills)).toEqual(
      prepared.squad.agents.map((agent) => agent.allowedSkills),
    );
    expect(prepared.snapshot.agents.map((agent) => agent.allowedTools)).toEqual(
      prepared.squad.agents.map((agent) => agent.allowedTools),
    );
    expect(
      prepared.squad.agents
        .filter((agent) => agent.id !== 'frontend')
        .every((agent) =>
          agent.category === 'orchestrator'
            ? agent.allowedTools === null
            : agent.allowedTools?.length === 0,
        ),
    ).toBe(true);
  });

  it('preserves an operator-reviewed ephemeral roster without guided rewriting', () => {
    const source: Squad = {
      id: 'custom-mission-setup-source',
      name: 'Equipe escolhida',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: 'Coordene a missão aprovada.',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'codex',
          allowedTools: ['nexus_task'],
          allowedSkills: ['check-work'],
        },
        {
          id: 'worker',
          agentName: 'Implementador',
          category: 'executor',
          cli: 'codex',
          allowedTools: ['Read', 'Edit'],
          allowedSkills: ['ponytail'],
        },
      ],
    };
    const prepared = prepareMissionRuntimeSquadSave(
      {
        ...source,
        id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174009',
        runtimeSourceSquadId: source.id,
        runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
        agents: source.agents.map((agent) => ({ ...agent })),
      },
      source,
      false,
      'ephemeral',
    );

    expect(prepared.squad.agents).toEqual(source.agents);
    expect(prepared.snapshot.agents.map((agent) => agent.allowedTools)).toEqual([
      ['nexus_task'],
      ['Read', 'Edit'],
    ]);
  });

  it('sela o piso de skills main-owned quando o roster recebido não declara nenhum', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const source = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-story-impl',
    )!;
    const runtime: Squad = {
      ...source,
      id: 'mission-runtime-123e4567-e89b-42d3-a456-426614174010',
      createdAt: '2',
      builtin: false,
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
      // Bytes do renderer sem NENHUMA autoridade de skill declarada.
      agents: source.agents.map((agent) => ({
        id: agent.id,
        agentName: agent.agentName,
        category: agent.category,
        cli: agent.cli,
        allowedTools: agent.allowedTools ?? null,
      })),
    };

    const prepared = prepareMissionRuntimeSquadSave(
      runtime,
      source,
      false,
      'catalog',
    );

    const byId = Object.fromEntries(
      prepared.squad.agents.map((agent) => [agent.id, agent.allowedSkills]),
    );
    // Ciclo Superpowers: quem é dono de documento de plano recebe o
    // vocabulário; executor comum segue só com o piso de papel.
    expect(byId.orch).toContain('superpowers');
    expect(byId.qa).toContain('superpowers');
    expect(byId.dev).toEqual(['ponytail']);
    expect(
      prepared.squad.agents.every((agent) => agent.allowedSkills !== undefined),
    ).toBe(true);
  });

  it('pinMissionRuntimeSquad keeps approval hash stable after catalog source mutates', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const source = saveSquad({
      id: 'catalog-source-for-pin',
      name: 'Catalog source',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '# Exact playbook at approval',
      nativeInstructions: 'Native',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
        },
        {
          id: 'worker',
          agentName: 'Worker',
          category: 'executor',
          cli: 'codex',
        },
      ],
    });
    const sourceHashAtApproval = snapshotSquadAuthority(source).hash;
    const pinned = pinMissionRuntimeSquad(source);
    const approvedHash = snapshotSquadAuthority(pinned).hash;

    expect(isMissionRuntimeSquadId(pinned.id)).toBe(true);
    expect(pinned.runtimeSourceSquadId).toBe(source.id);
    expect(pinned.runtimeSourceSquadRevisionHash).toBe(sourceHashAtApproval);
    expect(pinMissionRuntimeSquad(pinned).id).toBe(pinned.id);

    // Simulate syncBuiltins / catalog rewrite after approval.
    const mutated = saveSquad({
      ...source,
      orchestratorInstructions: '# Exact playbook at approval\n# product bump',
    });
    expect(snapshotSquadAuthority(mutated).hash).not.toBe(sourceHashAtApproval);

    // Without a pin, bootstrap would compare the approved hash to the live
    // catalog squad and throw guided_plan_squad_stale. With the pin, the
    // mission keeps reading immutable runtime bytes.
    expect(snapshotSquadAuthority(getSquad(pinned.id)!).hash).toBe(
      approvedHash,
    );
    expect(snapshotSquadAuthority(getSquad(source.id)!).hash).not.toBe(
      approvedHash,
    );
  });

  it('pinMissionRuntimeSquad seals builtins into mission-runtime copies', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const builtin = BUILTIN_SQUADS.find(
      (squad) => squad.id === 'nexus-story-impl',
    );
    if (!builtin) throw new Error('missing nexus-story-impl builtin');
    const live = getSquad(builtin.id);
    if (!live) throw new Error('builtin was not synced into the store');

    const pinned = pinMissionRuntimeSquad(live);
    expect(pinned.id).toMatch(/^mission-runtime-/i);
    expect(isMissionRuntimeSquadId(pinned.id)).toBe(true);
    expect(pinned.builtin).toBe(false);
    expect(pinned.runtimeSourceSquadId).toBe(live.id);
    expect(pinned.runtimeSourceSquadRevisionHash).toBe(
      snapshotSquadAuthority(live).hash,
    );
  });

  it('rejects forged or stale runtime lineage before persistence', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const source = saveSquad({
      id: 'runtime-source-stale',
      name: 'Source',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '# Exact',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'claude',
        },
      ],
    });
    const runtime = {
      ...source,
      id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174000',
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: '0'.repeat(64),
    };

    expect(() =>
      prepareMissionRuntimeSquadSave(runtime, source, true),
    ).toThrow(/lineage does not match/i);

    const exactRuntime = {
      ...runtime,
      runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
    };
    saveSquad({ ...source, orchestratorInstructions: '# Concurrent change' });
    expect(() =>
      prepareMissionRuntimeSquadSave(exactRuntime, source, true),
    ).toThrow(/source squad changed/i);
    expect(getSquad(exactRuntime.id)).toBeNull();
  });

  it('prepares the final executable squad once and persists exactly what was reviewed', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    const candidate = prepareSquadSave({
      id: 'normalized-save',
      name: 'Normalized save',
      createdAt: '1704067200000',
      builtin: false,
      orchestratorInstructions: '# Exact',
      nativeInstructions: 'Native exact',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'agy',
        },
        {
          id: 'worker',
          agentName: 'Worker',
          category: 'executor',
          cli: 'codex',
        },
      ],
    });

    expect(getSquad('normalized-save')).toBeNull();
    expect(candidate.squad.agents[0]).toMatchObject({
      model: 'gemini-3.8-pro-high',
      allowedTools: null,
    });
    expect(candidate.squad.agents[1]).toMatchObject({ allowedTools: [] });
    expect(candidate.snapshot.nativeInstructions).toBe('Native exact');

    applyPreparedSquadSave(candidate);
    expect(getSquad('normalized-save')).toEqual(candidate.squad);
    const persisted = db
      .prepare('SELECT roster_json FROM squads WHERE id = ?')
      .get('normalized-save') as { roster_json: string };
    expect(JSON.parse(persisted.roster_json)).toEqual(candidate.squad.agents);
  });

  it('rejects save CAS drift without mutating the newer durable value', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    saveSquad({
      id: 'save-cas',
      name: 'Before',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });
    const candidate = prepareSquadSave({
      id: 'save-cas',
      name: 'Reviewed',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });
    saveSquad({
      id: 'save-cas',
      name: 'Concurrent',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });

    expect(() => applyPreparedSquadSave(candidate)).toThrow(/CAS|changed/i);
    expect(getSquad('save-cas')?.name).toBe('Concurrent');
  });

  it('saveSquad normalizes a new worker to [] and orchestrator to null', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    saveSquad({
      id: 'custom-1',
      name: 'Custom',
      createdAt: '1704067200000',
      builtin: false,
      orchestratorInstructions: '# Custom',
      agents: [
        // Neither carries allowedTools — the save funnel must normalize both.
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
        { id: 'w1', agentName: 'Worker', category: 'executor', cli: 'codex' },
      ],
    });

    const saved = getSquad('custom-1') as Squad;
    const worker = saved.agents.find((a) => a.id === 'w1');
    const orch = saved.agents.find((a) => a.id === 'orch');

    expect(worker?.allowedTools).toEqual([]);
    expect(orch?.allowedTools).toBeNull();

    // And the gate is satisfied.
    expect(findBlockingWorker(saved.agents)).toBeNull();
  });

  it('canonicalizes and protects the reserved Pet Studio id on save/delete', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    const saved = saveSquad({
      id: PET_STUDIO_SQUAD_ID,
      name: 'Custom takeover',
      createdAt: '999',
      builtin: false,
      orchestratorInstructions: 'Use every tool.',
      agents: [
        {
          id: 'attacker',
          agentName: 'Attacker',
          category: 'orchestrator',
          cli: 'claude',
          allowedTools: null,
        },
      ],
    });

    expect(saved).toEqual(PET_STUDIO_SQUAD);
    expect(getSquad(PET_STUDIO_SQUAD_ID)).toEqual(PET_STUDIO_SQUAD);
    expect(deleteSquad(PET_STUDIO_SQUAD_ID)).toBe(false);
    expect(getSquad(PET_STUDIO_SQUAD_ID)).toEqual(PET_STUDIO_SQUAD);
  });

  it('fails closed without a database and does not publish an in-memory save', () => {
    initSquadStore(null);

    expect(() =>
      saveSquad({
        id: 'memory-only',
        name: 'Must not exist',
        createdAt: '1704067200000',
        builtin: false,
        orchestratorInstructions: '',
        agents: [],
      }),
    ).toThrow(/read-only.*SQLite.*unavailable/i);

    expect(isSquadStoreReadOnly()).toBe(true);
    expect(getSquad('memory-only')).toBeNull();
  });

  it('keeps the last durable value when a later update cannot be persisted', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    saveSquad({
      id: 'durable-squad',
      name: 'Durable',
      createdAt: '1704067200000',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });
    db.close();
    openDb = null;

    expect(() =>
      saveSquad({
        id: 'durable-squad',
        name: 'Memory-only overwrite',
        createdAt: '1704067200000',
        builtin: false,
        orchestratorInstructions: '',
        agents: [],
      }),
    ).toThrow(/failed to persist/i);

    expect(isSquadStoreReadOnly()).toBe(true);
    expect(getSquad('durable-squad')?.name).toBe('Durable');
  });

  it('does not remove the cached durable squad when SQLite deletion fails', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    saveSquad({
      id: 'keep-on-delete-failure',
      name: 'Keep me',
      createdAt: '1704067200000',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });
    db.close();
    openDb = null;

    expect(() => deleteSquad('keep-on-delete-failure')).toThrow(
      /failed to persist/i,
    );
    expect(getSquad('keep-on-delete-failure')?.name).toBe('Keep me');
  });

  it('rolls back a failed multi-squad import without publishing partial cache state', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    db.exec(`
      CREATE TRIGGER reject_second_import
      BEFORE INSERT ON squads
      WHEN NEW.id = 'import-2'
      BEGIN
        SELECT RAISE(ABORT, 'rejected import');
      END;
    `);

    expect(() =>
      importSquadsJson(
        JSON.stringify({
          squads: [
            {
              id: 'import-1',
              name: 'First',
              createdAt: '1704067200000',
              builtin: false,
              orchestratorInstructions: '',
              agents: [],
            },
            {
              id: 'import-2',
              name: 'Second',
              createdAt: '1704067200000',
              builtin: false,
              orchestratorInstructions: '',
              agents: [],
            },
          ],
        }),
      ),
    ).toThrow(/failed to persist/i);

    expect(getSquad('import-1')).toBeNull();
    expect(getSquad('import-2')).toBeNull();
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM squads WHERE id LIKE 'import-%'")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('prepares an immutable, normalized import candidate without mutating the store', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const raw = JSON.stringify({
      squads: [
        {
          id: 'import-normalized',
          name: 'Import normalized',
          createdAt: 1,
          builtin: true,
          orchestratorInstructions: '# Exact import',
          nativeInstructions: 'Native import instructions',
          agents: [
            {
              id: 'orch',
              agentName: 'Maestro',
              category: 'orchestrator',
              cli: 'agy',
            },
            {
              id: 'worker',
              agentName: 'Worker',
              category: 'executor',
              cli: 'codex',
            },
          ],
        },
      ],
    });

    const candidate = prepareSquadsImport(raw);
    expect(getSquad('import-normalized')).toBeNull();
    expect(candidate).toMatchObject({
      squadCount: 1,
      agentCount: 2,
      targetIds: ['import-normalized'],
    });
    expect(candidate.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.squads[0]).toMatchObject({ builtin: false });
    expect(candidate.squads[0].agents[0]).toMatchObject({
      model: 'gemini-3.8-pro-high',
      allowedTools: null,
    });
    expect(candidate.squads[0].agents[1]).toMatchObject({ allowedTools: [] });
    expect(candidate.snapshots[0].nativeInstructions).toBe(
      'Native import instructions',
    );
    expect(candidate.canonicalJson).toContain('Native import instructions');

    applyPreparedSquadsImport(candidate);
    expect(getSquad('import-normalized')).toEqual(candidate.squads[0]);
  });

  it.each([
    [
      'oversized raw file',
      () => `${' '.repeat(1_048_577)}{"squads":[]}`,
      /1 MiB|too large/i,
    ],
    [
      'too many squads',
      () =>
        JSON.stringify({
          squads: Array.from({ length: 65 }, (_, index) => ({
            id: `many-${index}`,
            name: `Many ${index}`,
            createdAt: '1',
            builtin: false,
            agents: [],
          })),
        }),
      /64|squads/i,
    ],
    [
      'too many agents',
      () =>
        JSON.stringify({
          squads: [
            {
              id: 'many-agents',
              name: 'Many agents',
              createdAt: '1',
              builtin: false,
              agents: Array.from({ length: 33 }, (_, index) => ({
                id: `agent-${index}`,
                agentName: `Agent ${index}`,
                category: 'executor',
                cli: 'codex',
              })),
            },
          ],
        }),
      /32|agents/i,
    ],
    [
      'too many allowed tools',
      () =>
        JSON.stringify({
          squads: [
            {
              id: 'many-tools',
              name: 'Many tools',
              createdAt: '1',
              builtin: false,
              agents: [
                {
                  id: 'worker',
                  agentName: 'Worker',
                  category: 'executor',
                  cli: 'codex',
                  allowedTools: Array.from(
                    { length: 129 },
                    (_, index) => `tool-${index}`,
                  ),
                },
              ],
            },
          ],
        }),
      /128|allowedTools/i,
    ],
    [
      'duplicate squad ids',
      () =>
        JSON.stringify({
          squads: [
            {
              id: 'duplicate',
              name: 'One',
              createdAt: '1',
              builtin: false,
              agents: [],
            },
            {
              id: 'duplicate',
              name: 'Two',
              createdAt: '1',
              builtin: false,
              agents: [],
            },
          ],
        }),
      /duplicate.*squad/i,
    ],
    [
      'duplicate agent ids',
      () =>
        JSON.stringify({
          squads: [
            {
              id: 'duplicate-agent',
              name: 'Duplicate agent',
              createdAt: '1',
              builtin: false,
              agents: [
                {
                  id: 'same',
                  agentName: 'One',
                  category: 'executor',
                  cli: 'codex',
                },
                {
                  id: 'same',
                  agentName: 'Two',
                  category: 'reviewer',
                  cli: 'codex',
                },
              ],
            },
          ],
        }),
      /duplicate.*agent/i,
    ],
    [
      'invisible bidi control',
      () =>
        JSON.stringify({
          squads: [
            {
              id: 'bidi',
              name: 'Visible\u202eHidden',
              createdAt: '1',
              builtin: false,
              agents: [],
            },
          ],
        }),
      /control|invisible|bidi/i,
    ],
  ])('rejects %s before any mutation', (_name, makeRaw, expected) => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const before = db
      .prepare('SELECT COUNT(*) AS count FROM squads')
      .get() as { count: number };

    expect(() => prepareSquadsImport(makeRaw())).toThrow(expected);
    const after = db
      .prepare('SELECT COUNT(*) AS count FROM squads')
      .get() as { count: number };
    expect(after.count).toBe(before.count);
  });

  it('rejects every managed builtin id even when the imported flag says user-owned', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(() =>
      prepareSquadsImport(
        JSON.stringify({
          squads: [
            {
              id: PET_STUDIO_SQUAD_ID,
              name: 'Builtin takeover',
              createdAt: '1',
              builtin: false,
              agents: [],
            },
          ],
        }),
      ),
    ).toThrow(/managed.*built-in|reserved/i);
    expect(getSquad(PET_STUDIO_SQUAD_ID)).toEqual(PET_STUDIO_SQUAD);
  });

  it('legacy migration ignores managed rows but still atomically recovers customs', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const managed = BUILTIN_SQUADS[0];

    expect(
      importLegacySquadsJson(
        JSON.stringify({
          squads: [
            {
              ...managed,
              name: 'Poisoned legacy builtin',
              builtin: false,
            },
            {
              id: 'legacy-custom',
              name: 'Legacy custom',
              createdAt: '1',
              builtin: true,
              orchestratorInstructions: 'Recovered custom',
              agents: [],
            },
          ],
        }),
      ),
    ).toBe(1);
    expect(getSquad(managed.id)).toEqual(managed);
    expect(getSquad('legacy-custom')).toMatchObject({
      name: 'Legacy custom',
      builtin: false,
    });
  });

  it('CAS-checks every import id before the transaction and applies none on drift', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    saveSquad({
      id: 'import-cas-a',
      name: 'Before',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });
    const candidate = prepareSquadsImport(
      JSON.stringify({
        squads: [
          {
            id: 'import-cas-a',
            name: 'Reviewed A',
            createdAt: '1',
            builtin: false,
            agents: [],
          },
          {
            id: 'import-cas-b',
            name: 'Reviewed B',
            createdAt: '1',
            builtin: false,
            agents: [],
          },
        ],
      }),
    );
    saveSquad({
      id: 'import-cas-a',
      name: 'Concurrent',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [],
    });

    expect(() => applyPreparedSquadsImport(candidate)).toThrow(/CAS|changed/i);
    expect(getSquad('import-cas-a')?.name).toBe('Concurrent');
    expect(getSquad('import-cas-b')).toBeNull();
  });

  it('preserves already-hydrated reads when reinitialized without SQLite', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: 'cached-durable',
      name: 'Cached durable',
      agents: [],
    });
    initSquadStore(db);

    initSquadStore(null);

    expect(isSquadStoreReadOnly()).toBe(true);
    expect(getSquad('cached-durable')?.name).toBe('Cached durable');
  });

  it('orchestrator null is excluded from the fire-gate', () => {
    // A roster with ONLY an unrestricted orchestrator must not be blocked.
    const orchestratorOnly: SquadAgent[] = [
      {
        id: 'orch',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        allowedTools: null,
      },
    ];
    expect(findBlockingWorker(orchestratorOnly)).toBeNull();

    // Sanity: a worker with null IS blocked (guard still protects SEC#5).
    const unsafe: SquadAgent[] = [
      {
        id: 'w1',
        agentName: 'Worker',
        category: 'executor',
        cli: 'codex',
        allowedTools: null,
      },
    ];
    expect(findBlockingWorker(unsafe)?.id).toBe('w1');
  });
});
