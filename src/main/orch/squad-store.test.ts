import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  findAgent,
  findAgentInAnySquad,
  findAgentInSquad,
  getSquad,
  importSquadsJson,
  importLegacySquadsJson,
  initSquadStore,
  isSquadStoreReadOnly,
  pinMissionRuntimeSquad,
  prepareMissionRuntimeSquadSave,
  prepareSquadSave,
  prepareSquadsImport,
  requireCatalogAgent,
  saveSquad,
  squadRoutableCliIds,
} from './squad-store';
import { assertUniqueAgentNames } from './squad-agent-names';
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

/** F-1503: o menor roster que uma missão aceita (um coordenador). */
const MAESTRO_ONLY = [
  { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
];

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

describe('F-1500: nome de integrante repetido ou com espaço nas pontas', () => {
  it('acha o integrante pelo nome sem os espaços das pontas', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: 'f1500-spaces',
      name: 'Equipe com espaço',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'f1500-dev', agentName: 'Dev Espaço ', category: 'executor', cli: 'codex', allowedTools: [] },
      ],
    });
    initSquadStore(db);

    expect(findAgentInSquad('f1500-spaces', 'Dev Espaço')?.agent.id).toBe('f1500-dev');
    expect(findAgentInSquad('f1500-spaces', ' Dev Espaço ')?.agent.id).toBe('f1500-dev');
    expect(findAgentInAnySquad('Dev Espaço')?.agent.id).toBe('f1500-dev');
    expect(requireCatalogAgent('Dev Espaço').agent.id).toBe('f1500-dev');
  });

  it('recusa salvar equipe com dois integrantes de mesmo nome, dizendo qual', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const twoDevs = {
      id: 'f1500-duplicate',
      name: 'Dois Devs',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
        { id: 'dev-a', agentName: 'Dev', category: 'executor', cli: 'codex' },
        { id: 'dev-b', agentName: 'Dev ', category: 'executor', cli: 'grok' },
      ],
    };

    expect(() => saveSquad(twoDevs)).toThrow(
      /mais de um integrante chamado `Dev`/,
    );
    expect(getSquad('f1500-duplicate')).toBeNull();
    // Os built-ins também passam pelo selo de missão (pinMissionRuntimeSquad).
    for (const builtin of BUILTIN_SQUADS) {
      expect(() => assertUniqueAgentNames(builtin.agents)).not.toThrow();
    }
  });

  it('carrega a equipe antiga com nome repetido em vez de sumir com ela', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: 'f1500-legacy',
      name: 'Equipe antiga com dois Devs',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'dev-a', agentName: 'Dev', category: 'executor', cli: 'codex', allowedTools: [] },
        { id: 'dev-b', agentName: 'Dev', category: 'executor', cli: 'grok', allowedTools: [] },
      ],
    });
    initSquadStore(db);

    // Continua no catálogo (o usuário renomeia no editor); o prepare recusa
    // dizendo o nome repetido, e o id continua resolvendo cada um.
    expect(getSquad('f1500-legacy')?.agents).toHaveLength(3);
    expect(findAgentInSquad('f1500-legacy', 'dev-b')?.agent.cli).toBe('grok');
  });

  it('missão selada antes da regra com `Dev` e `Dev ` abre cada um pelo nome exato', () => {
    const db = makeDb();
    openDb = db;
    const runtimeId = 'mission-runtime-123e4567-e89b-42d3-a456-426614175000';
    insertRawSquad(db, {
      id: runtimeId,
      name: 'Missão selada com dois Devs',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'old-a', agentName: 'Dev', category: 'executor', cli: 'codex', allowedTools: [] },
        { id: 'old-b', agentName: 'Dev ', category: 'executor', cli: 'grok', allowedTools: [] },
      ],
    });
    initSquadStore(db);

    // O nome exato vence o aparado: a cópia selada não pode ser renomeada.
    expect(findAgentInSquad(runtimeId, 'Dev')?.agent.id).toBe('old-a');
    expect(findAgentInSquad(runtimeId, 'Dev ')?.agent.id).toBe('old-b');
    expect(findAgentInSquad(runtimeId, 'old-b')?.agent.id).toBe('old-b');
    // Sem nome exato, o aparado casa os dois e continua ambíguo.
    expect(findAgentInSquad(runtimeId, ' Dev  ')).toBeNull();
  });

  it('id com espaço nas pontas casa literalmente antes de qualquer nome', () => {
    const db = makeDb();
    openDb = db;
    insertRawSquad(db, {
      id: 'f1500-spaced-ids',
      name: 'Ids com espaço',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'dev ', agentName: 'Implementador A', category: 'executor', cli: 'codex', allowedTools: [] },
        { id: 'dev', agentName: 'Implementador B', category: 'executor', cli: 'claude', allowedTools: [] },
      ],
    });
    insertRawSquad(db, {
      id: 'f1500-id-vs-name',
      name: 'Id contra nome',
      agents: [
        { id: 'orch2', agentName: 'Maestro 2', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'impl', agentName: 'Implementador', category: 'executor', cli: 'codex', allowedTools: [] },
        { id: 'qa', agentName: 'impl ', category: 'reviewer', cli: 'claude', allowedTools: [] },
        // Renomeado para o id de outro integrante: o id literal vence.
        { id: 'backend', agentName: 'qa', category: 'executor', cli: 'grok', allowedTools: [] },
      ],
    });
    initSquadStore(db);

    expect(findAgentInSquad('f1500-spaced-ids', 'dev ')?.agent.cli).toBe('codex');
    expect(findAgentInSquad('f1500-spaced-ids', 'dev')?.agent.cli).toBe('claude');
    expect(findAgent('dev ')?.agent.cli).toBe('codex');
    expect(findAgentInAnySquad('dev ')?.agent.cli).toBe('codex');
    expect(requireCatalogAgent('dev ').agent.cli).toBe('codex');
    expect(requireCatalogAgent('f1500-spaced-ids:dev ').agent.cli).toBe('codex');
    expect(findAgentInSquad('f1500-id-vs-name', 'impl')?.agent.id).toBe('impl');
    expect(findAgentInSquad('f1500-id-vs-name', 'qa')?.agent.id).toBe('qa');
  });
});

describe('F-1314: agente do catálogo numa missão sem squad', () => {
  it('resolve só squads salvos e recusa o nome ambíguo listando squadId:agentId', () => {
    const db = makeDb();
    openDb = db;
    const runtimeId = 'agentic-runtime-0e1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    insertRawSquad(db, {
      id: runtimeId,
      name: 'Equipe da missão',
      agents: [{ id: 'interface-executor', agentName: 'Implementar interface', category: 'executor', cli: 'codex', allowedTools: [] }],
    });
    insertRawSquad(db, {
      id: 'f1314-kimi',
      name: 'Kimi',
      agents: [{ id: 'f1314-writer', agentName: 'Kimi Writer', category: 'executor', cli: 'kimi', allowedTools: [] }],
    });
    insertRawSquad(db, {
      id: 'f1314-codex',
      name: 'Codex',
      agents: [{ id: 'f1314-writer', agentName: 'Codex Writer', category: 'executor', cli: 'codex', allowedTools: [] }],
    });
    initSquadStore(db);
    expect(getSquad(runtimeId)?.agents[0]?.id).toBe('interface-executor');

    expect(requireCatalogAgent('Kimi Writer').agent.cli).toBe('kimi');
    // Snapshot de missão é evidência da missão que o criou, não catálogo.
    expect(() => requireCatalogAgent('interface-executor')).toThrow(/unknown squad agent: interface-executor/);
    expect(() => requireCatalogAgent('f1314-writer')).toThrow(
      /f1314-kimi:f1314-writer.*f1314-codex:f1314-writer|f1314-codex:f1314-writer.*f1314-kimi:f1314-writer/,
    );
    expect(requireCatalogAgent('f1314-codex:f1314-writer').agent.cli).toBe('codex');
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

  it('F-1498: squad salvo antes do piso de skills volta com permissões revisadas', () => {
    const db = makeDb();
    openDb = db;
    // Linha gravada entre 23/07 e 02/08: `allowedTools` normalizado, sem
    // `allowedSkills`. O prepare recusa "não possui permissões revisadas".
    insertRawSquad(db, {
      id: 'old-skills',
      name: 'Equipe antiga',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null },
        { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex', model: 'gpt-6.1-sol', allowedTools: [] },
        { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'codex', model: 'gpt-6.1-sol', allowedTools: [] },
      ],
    });

    initSquadStore(db);

    const loaded = getSquad('old-skills') as Squad;
    expect(
      loaded.agents.filter((agent) => agent.allowedSkills === undefined),
    ).toEqual([]);
    // O piso é o mesmo do salvar: executor ganha ponytail, revisor check-work.
    expect(loaded.agents.find((agent) => agent.id === 'dev')?.allowedSkills).toContain('ponytail');
    expect(loaded.agents.find((agent) => agent.id === 'qa')?.allowedSkills).toContain('check-work');
    const row = db
      .prepare('SELECT roster_json FROM squads WHERE id = ?')
      .get('old-skills') as { roster_json: string };
    expect(
      (JSON.parse(row.roster_json) as SquadAgent[]).every(
        (agent) => agent.allowedSkills !== undefined,
      ),
    ).toBe(true);
  });

  it('F-1499: cópia selada sem modelo mantém bytes e hash depois de reiniciar', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    // Roster do wizard (Nova missão): o operador deixou Codex, Grok e AGY no
    // padrão da CLI, sem modelo. O selo guarda exatamente esses bytes.
    const source: Squad = {
      id: 'custom-mission-setup-f1499',
      name: 'Equipe — F-1499',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: 'Coordene a missão aprovada.',
      agents: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', allowedTools: null, allowedSkills: [] },
        { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex', allowedTools: [], allowedSkills: ['ponytail'] },
        { id: 'scout', agentName: 'Scout', category: 'scout', cli: 'agy', allowedTools: [], allowedSkills: [] },
        { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'grok', allowedTools: [], allowedSkills: ['check-work'] },
      ],
    };
    const sealed = applyPreparedSquadSave(
      prepareMissionRuntimeSquadSave(
        {
          ...source,
          id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174045',
          createdAt: '2',
          runtimeSourceSquadId: source.id,
          runtimeSourceSquadRevisionHash: snapshotSquadAuthority(source).hash,
          agents: source.agents.map((agent) => ({ ...agent })),
        },
        source,
        false,
        'ephemeral',
      ),
    );
    const sealedHash = snapshotSquadAuthority(sealed).hash;
    const rowOf = () =>
      db
        .prepare('SELECT roster_json FROM squads WHERE id = ?')
        .get(sealed.id) as { roster_json: string };
    const sealedRow = rowOf().roster_json;
    expect(sealed.agents.map((agent) => agent.model)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    // Reiniciar o app hidrata de novo do SQLite.
    initSquadStore(db);

    const rehydrated = getSquad(sealed.id) as Squad;
    expect(rehydrated.agents.map((agent) => agent.model)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(snapshotSquadAuthority(rehydrated).hash).toBe(sealedHash);
    expect(rowOf().roster_json).toBe(sealedRow);
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
      model: 'gemini-3.8-flash-high',
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
      agents: MAESTRO_ONLY,
    });
    const candidate = prepareSquadSave({
      id: 'save-cas',
      name: 'Reviewed',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: MAESTRO_ONLY,
    });
    saveSquad({
      id: 'save-cas',
      name: 'Concurrent',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '',
      agents: MAESTRO_ONLY,
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
        agents: MAESTRO_ONLY,
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
      agents: MAESTRO_ONLY,
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
        agents: MAESTRO_ONLY,
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
      agents: MAESTRO_ONLY,
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
              agents: MAESTRO_ONLY,
            },
            {
              id: 'import-2',
              name: 'Second',
              createdAt: '1704067200000',
              builtin: false,
              orchestratorInstructions: '',
              agents: MAESTRO_ONLY,
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
      model: 'gemini-3.8-flash-high',
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

  it('never imports a managed builtin id even when the imported flag says user-owned', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    // F-1502: o id reservado é ignorado com aviso (antes recusava o arquivo
    // inteiro); continua sem poder sobrescrever o squad do app.
    const candidate = prepareSquadsImport(
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
    );
    expect(candidate.targetIds).toEqual([]);
    expect(candidate.skippedIds).toEqual([PET_STUDIO_SQUAD_ID]);
    expect(applyPreparedSquadsImport(candidate)).toBe(0);
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
      agents: MAESTRO_ONLY,
    });
    const candidate = prepareSquadsImport(
      JSON.stringify({
        squads: [
          {
            id: 'import-cas-a',
            name: 'Reviewed A',
            createdAt: '1',
            builtin: false,
            agents: MAESTRO_ONLY,
          },
          {
            id: 'import-cas-b',
            name: 'Reviewed B',
            createdAt: '1',
            builtin: false,
            agents: MAESTRO_ONLY,
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
      agents: MAESTRO_ONLY,
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

describe('F-1502: levar os squads para outro PC pelo exportar/importar do app', () => {
  const userSquad = {
    id: 'f1502-meu-squad',
    name: 'Meu squad',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '# Meu squad',
    agents: [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
      { id: 'dev', agentName: 'Dev', category: 'executor', cli: 'codex' },
    ],
  };

  it('o arquivo exportado importa no outro PC e traz só os squads do usuário', () => {
    const source = makeDb();
    initSquadStore(source);
    const saved = saveSquad(userSquad);
    const exported = exportSquadsJson();
    source.close();

    const target = makeDb();
    openDb = target;
    initSquadStore(target);
    const candidate = prepareSquadsImport(Buffer.from(exported, 'utf8'));

    expect(candidate.targetIds).toEqual([saved.id]);
    expect(applyPreparedSquadsImport(candidate)).toBe(1);
    expect(getSquad(saved.id)).toEqual(saved);
    for (const builtin of BUILTIN_SQUADS) {
      expect(getSquad(builtin.id)).toEqual(builtin);
    }
  });

  it('arquivo de versão antiga com squads internos ignora esses ids e avisa, sem recusar o arquivo', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const managed = BUILTIN_SQUADS.find((squad) => squad.id !== PET_STUDIO_SQUAD_ID)!;
    // Exportações antigas também levavam a cópia selada de cada missão.
    const runtimeId = 'mission-runtime-123e4567-e89b-42d3-a456-426614174099';

    const candidate = prepareSquadsImport(
      JSON.stringify({
        squads: [
          { ...managed, name: 'Cópia velha do interno' },
          { ...PET_STUDIO_SQUAD, builtin: false },
          {
            ...userSquad,
            id: runtimeId,
            runtimeSourceSquadId: userSquad.id,
            runtimeSourceSquadRevisionHash: 'a'.repeat(64),
          },
          userSquad,
        ],
      }),
    );

    expect(candidate.targetIds).toEqual([userSquad.id]);
    expect(candidate.skippedIds).toEqual([
      managed.id,
      PET_STUDIO_SQUAD_ID,
      runtimeId,
    ]);
    expect(applyPreparedSquadsImport(candidate)).toBe(1);
    expect(getSquad(managed.id)).toEqual(managed);
    expect(getSquad(PET_STUDIO_SQUAD_ID)).toEqual(PET_STUDIO_SQUAD);
    expect(getSquad(runtimeId)).toBeNull();
  });
});

describe('F-1503: salvar recusa o squad que nenhuma missão consegue usar', () => {
  const maestro = { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' };
  function workers(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `dev-${index}`,
      agentName: `Dev ${index}`,
      category: 'executor',
      cli: 'codex',
    }));
  }
  function squadWith(id: string, agents: unknown[]) {
    return { id, name: `Squad ${id}`, createdAt: '1', builtin: false, agents };
  }

  it.each([
    ['sem coordenador', [...workers(2)], /precisa de exatamente um coordenador.*e tem 0/],
    ['com dois coordenadores', [maestro, { ...maestro, id: 'orch-2', agentName: 'Maestro 2' }], /precisa de exatamente um coordenador.*e tem 2/],
    ['com 13 integrantes', [maestro, ...workers(12)], /tem 13 integrantes e uma missão aceita no máximo 12; remova 1/],
  ])('save (MCP/IPC) recusa o squad %s sem gravar nada', (_label, agents, expected) => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const id = `f1503-${agents.length}`;

    expect(() => saveSquad(squadWith(id, agents))).toThrow(expected);
    expect(() => prepareSquadSave(squadWith(id, agents))).toThrow(/O squad "Squad f1503-\d+"/);
    expect(getSquad(id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM squads WHERE id = ?').get(id)).toEqual({ count: 0 });
  });

  it('save aceita um coordenador com até 12 integrantes', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(saveSquad(squadWith('f1503-ok', [maestro, ...workers(11)])).agents).toHaveLength(12);
  });

  it('importar recusa o arquivo com squad inutilizável, nomeando o squad, sem gravar nenhum', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(() =>
      prepareSquadsImport(
        JSON.stringify({
          squads: [
            squadWith('f1503-import-ok', [maestro, ...workers(1)]),
            squadWith('f1503-import-two', [maestro, { ...maestro, id: 'orch-2' }]),
          ],
        }),
      ),
    ).toThrow(/O squad "Squad f1503-import-two" \(f1503-import-two\) precisa de exatamente um coordenador/);
    expect(getSquad('f1503-import-ok')).toBeNull();
    expect(getSquad('f1503-import-two')).toBeNull();
  });

  it('importar recusa o arquivo com nome de integrante repetido, nomeando squad e nome, sem gravar nenhum', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);
    const dev = { id: 'dev-a', agentName: 'Dev', category: 'executor', cli: 'codex' };
    const file = JSON.stringify({
      squads: [
        squadWith('f1503-import-fine', [maestro, ...workers(1)]),
        squadWith('f1503-import-dup', [maestro, dev, { ...dev, id: 'dev-b', agentName: 'Dev ', cli: 'grok' }]),
      ],
    });

    // Mesma regra do salvar e do prepare (F-1500): o arquivo é atômico.
    expect(() => prepareSquadsImport(file)).toThrow(
      /O squad "Squad f1503-import-dup" \(f1503-import-dup\) tem mais de um integrante chamado `Dev`.*nada foi importado/,
    );
    expect(() => importSquadsJson(file)).toThrow(/mais de um integrante chamado `Dev`/);
    expect(getSquad('f1503-import-fine')).toBeNull();
    expect(getSquad('f1503-import-dup')).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM squads WHERE id LIKE 'f1503-import-%'").get()).toEqual({ count: 0 });

    // A migração de primeiro boot recupera o que o usuário tinha; o editor corrige.
    expect(importLegacySquadsJson(file)).toBe(2);
    expect(getSquad('f1503-import-dup')?.agents.map((agent) => agent.agentName)).toEqual(['Maestro', 'Dev', 'Dev ']);
  });
});

describe('F-1505: arquivo de squads gravado no Windows (BOM e UTF-16)', () => {
  const fileSquad = {
    id: 'f1505-windows',
    name: 'Equipe do Windows — ação',
    createdAt: '1',
    builtin: false,
    agents: [{ id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' }],
  };
  const json = JSON.stringify({ squads: [fileSquad] }, null, 2);
  const utf16be = (text: string) =>
    Buffer.from(text, 'utf16le').swap16();

  it.each([
    ['UTF-8 sem BOM', Buffer.from(json, 'utf8')],
    ['UTF-8 com BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')])],
    ['UTF-16 LE com BOM (Out-File do PowerShell 5.1)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])],
    ['UTF-16 BE com BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(json)])],
  ])('importa %s', (_label, bytes) => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    const candidate = prepareSquadsImport(bytes);

    expect(candidate.targetIds).toEqual([fileSquad.id]);
    expect(candidate.squads[0]?.name).toBe(fileSquad.name);
  });

  it('texto com BOM (caminho interno) também importa', () => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(importSquadsJson(`\uFEFF${json}`)).toBe(1);
    expect(getSquad(fileSquad.id)?.name).toBe(fileSquad.name);
  });

  it.each([
    ['Latin-1 sem BOM', Buffer.from(json.replace('\u2014', '\u00e9'), 'latin1'), /não está em UTF-8 nem em UTF-16 com BOM/],
    ['UTF-16 LE sem BOM', Buffer.from(json, 'utf16le'), /não está em UTF-8 nem em UTF-16 com BOM/],
    ['UTF-16 LE sem BOM só com ASCII', Buffer.from('{"squads": []}', 'utf16le'), /não é um JSON válido/],
    ['texto que não é JSON', Buffer.from('squads: nenhum', 'utf8'), /não é um JSON válido/],
    ['UTF-16 LE com BOM e byte sobrando', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le'), Buffer.from([0x7b])]), /não está em UTF-8 nem em UTF-16 com BOM/],
  ])('recusa %s com mensagem clara, sem gravar', (_label, bytes, expected) => {
    const db = makeDb();
    openDb = db;
    initSquadStore(db);

    expect(() => prepareSquadsImport(bytes)).toThrow(expected);
    expect(getSquad(fileSquad.id)).toBeNull();
  });

  it('a migração de ~/.nexus/squads.json com BOM UTF-8 recupera os squads', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1505-home-'));
    fs.mkdirSync(path.join(home, '.nexus'));
    fs.writeFileSync(
      path.join(home, '.nexus', 'squads.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]),
    );
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    try {
      const fresh = await import('./squad-store');
      const db = makeDb();
      openDb = db;
      fresh.initSquadStore(db);

      expect(fresh.getSquad(fileSquad.id)?.name).toBe(fileSquad.name);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
