import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../persistence/db';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { initSquadStore, getSquad, saveSquad } from './squad-store';

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
        native_instructions, roster_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    squad.id,
    squad.name,
    '1704067200000',
    squad.builtin ? 1 : 0,
    squad.orchestratorInstructions ?? '',
    '',
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
});

describe('squad-store save path', () => {
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
