import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAMIFICATION_CHANNELS } from '../../shared/gamification-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import type { ScopedMission, ScopedMissionStore } from '../orch/mission-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { getMeta, listXpEvents } from './gamification-store';
import { GlobalXpLedger } from './global-xp-ledger';
import {
  hasGreenEvidence,
  ProjectGamificationService,
} from './gamification-service';
import { createWorkflowState, type EvidenceBinding } from '../context/prevc-engine';
import type { TrustedEvidence } from '../context/sensor-broker';

const GREEN_ARTIFACT = {
  kind: 'verification',
  command: 'npm test',
  exitCode: 0,
};
const CONTEXT_REVISION = 'd'.repeat(64);
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const DIFF_HASH = 'e'.repeat(64);

function completeMission(
  store: ScopedMissionStore,
  mission: ScopedMission,
  evidenceIds: readonly string[] = [],
): ScopedMission {
  const running =
    mission.status === 'running'
      ? mission
      : store.setStatus(mission.id, 'running');
  if (!running) throw new Error('mission fixture did not enter running');
  const completed = store.transitionLifecycle(
    mission.id,
    {
      updatedAt: running.updatedAt,
      intentVersion: running.intentVersion ?? 0,
    },
    {
      status: 'done',
      intentState: 'done',
      learnings: `Verified test completion for ${mission.title}.`,
      result: {
        outcome: 'success',
        summary: `Verified test completion for ${mission.title}.`,
        evidenceIds: [...evidenceIds],
        artifactRefs: [],
      },
    },
  );
  if (!completed) throw new Error('mission fixture completion CAS failed');
  return completed;
}

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];
const registries: ProjectDomainStoreRegistry[] = [];
const services: ProjectGamificationService[] = [];

function createManager(
  options: Partial<ConstructorParameters<typeof ProjectRuntimeManager>[0]> = {},
): ProjectRuntimeManager {
  const runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
    ...options,
  });
  managers.push(runtimeManager);
  return runtimeManager;
}

function createRegistry(
  runtimeManager: ProjectRuntimeManager,
): ProjectDomainStoreRegistry {
  const registry = new ProjectDomainStoreRegistry(runtimeManager);
  registries.push(registry);
  return registry;
}

function createService(
  runtimeManager: ProjectRuntimeManager,
  registry: ProjectDomainStoreRegistry,
  options: {
    sober?: boolean;
    agentCategory?: (agentName: string) => string | null;
  } = {},
) {
  const broadcast = vi.fn();
  const service = new ProjectGamificationService({
    runtimeManager,
    domainStores: registry,
    broadcast,
    soberMode: () => options.sober ?? false,
    agentCategory: options.agentCategory,
  });
  services.push(service);
  service.start();
  return { service, broadcast };
}

function boot(options: { sober?: boolean } = {}) {
  const runtimeManager = createManager();
  const registry = createRegistry(runtimeManager);
  const created = createService(runtimeManager, registry, options);
  return { runtimeManager, registry, ...created };
}

function scope(
  projectId = 'project-a',
  checkoutId = 'checkout-main',
): ProjectExecutionScope {
  return testProjectScope({
    projectId,
    checkoutId,
    rootRealPath: `/workspace/${projectId}/${checkoutId}`,
  });
}

function narrations(broadcast: ReturnType<typeof vi.fn>): string[] {
  return broadcast.mock.calls
    .filter(([, channel]) => channel === 'voice:narrate')
    .map(([, , payload]) => (payload as { text: string }).text);
}

function xpEvents(
  runtimeManager: ProjectRuntimeManager,
  executionScope: ProjectExecutionScope,
) {
  return listXpEvents(runtimeManager.open(executionScope).db);
}

function recordCheapUsage(
  runtimeManager: ProjectRuntimeManager,
  executionScope: ProjectExecutionScope,
  missionId: string,
): void {
  runtimeManager
    .open(executionScope)
    .db.prepare(
      `INSERT INTO usage_events
         (id, mission_id, pane_id, provider, model, event_type, input_units,
          output_units, cost_micros, metadata_json, occurred_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      `usage-${missionId}`,
      missionId,
      'anthropic',
      'claude-sonnet',
      'tokens',
      10_000,
      10_000,
      10_000,
      Date.now(),
    );
}

function seedTrustedEvidence(
  runtimeManager: ProjectRuntimeManager,
  executionScope: ProjectExecutionScope,
  missionId: string,
  evidenceId: string,
): void {
  const contractHash = createHash('sha256').update(missionId).digest('hex');
  const binding: EvidenceBinding = {
    projectId: executionScope.projectId,
    checkoutId: executionScope.checkoutId,
    missionId,
    contractHash,
    contextHash: CONTEXT_REVISION,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    diffHash: DIFF_HASH,
  };
  const workflow = createWorkflowState('low', binding);
  const evidence: TrustedEvidence = {
    id: evidenceId,
    producer: 'nexus',
    ...binding,
    sensorId: 'unit',
    sensorConfigHash: 'f'.repeat(64),
    command: ['npm', 'test'],
    exitCode: 0,
    stdoutHash: '1'.repeat(64),
    stderrHash: '2'.repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:00:01.000Z',
  };
  const db = runtimeManager.open(executionScope).db;
  db.prepare(
    `INSERT INTO mission_contracts
       (mission_id, revision, contract_hash, context_revision, contract_json,
        author_id, author_session_id, author_provider, frozen_at)
     VALUES (?, 1, ?, ?, '{}', 'author', 'session', 'codex', 1)`,
  ).run(missionId, contractHash, CONTEXT_REVISION);
  db.prepare(
    `INSERT INTO workflow_states
       (mission_id, revision, stage, workflow_json, updated_at)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(missionId, workflow.revision, workflow.stage, JSON.stringify(workflow));
  db.prepare(
    `INSERT INTO sensor_evidence
       (id, mission_id, sensor_id, head_sha, diff_hash, passed,
        evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
  ).run(
    evidenceId,
    missionId,
    evidence.sensorId,
    HEAD_SHA,
    DIFF_HASH,
    JSON.stringify(evidence),
  );
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-gamification-service-'),
  );
});

afterEach(() => {
  vi.useRealTimers();
  for (const service of services.splice(0)) service.dispose();
  for (const registry of registries.splice(0)) registry.dispose();
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('hasGreenEvidence', () => {
  it('accepts only successful verification artifacts', () => {
    expect(hasGreenEvidence([GREEN_ARTIFACT])).toBe('npm test (exit 0)');
    expect(
      hasGreenEvidence([
        { kind: 'verification', command: 'npm test', exitCode: 1 },
      ]),
    ).toBeNull();
    expect(hasGreenEvidence([{ kind: 'file', path: 'a.ts' }, null])).toBeNull();
  });
});

describe('ProjectGamificationService on scoped runtimes', () => {
  it('awards only Nexus-trusted handoffs and ignores self-reported success', () => {
    const { runtimeManager, registry } = boot();
    const executionScope = scope();
    const suite = registry.forScope(executionScope);

    const mission = suite.missions.create({ title: 'Entrega confiável' });
    seedTrustedEvidence(runtimeManager, executionScope, mission.id, 'evidence-green');
    const untrusted = suite.handoffs.submit({
      status: 'success',
      summary: 'entrega simples de teste',
    });
    const trusted = suite.handoffs.submit({
      status: 'success',
      summary: 'entrega verde de teste',
      missionId: mission.id,
      evidenceIds: ['evidence-green'],
    });
    suite.handoffs.submit({
      status: 'failed',
      summary: 'tentativa que falhou',
    });

    const events = xpEvents(runtimeManager, executionScope);
    expect(events).toHaveLength(1);
    expect(events.find((event) => event.entityKey === `handoff:${untrusted.id}`))
      .toBeUndefined();
    expect(events.find((event) => event.kind === 'handoff_green')).toEqual(
      expect.objectContaining({
        entityKey: `handoff:${trusted.id}`,
        points: 8_000,
        evidence: 'evidence-green',
      }),
    );
  });

  it('awards handoffs the orchestrator accepted, never rework or unacknowledged ones', () => {
    const { runtimeManager, registry, service } = boot();
    const executionScope = scope();
    const suite = registry.forScope(executionScope);
    const mission = suite.missions.create({ title: 'Entregas aceitas' });
    const accepted = suite.handoffs.submit({
      status: 'success',
      summary: 'entrega aceita pelo orquestrador',
      missionId: mission.id,
    });
    const reworked = suite.handoffs.submit({
      status: 'success',
      summary: 'entrega devolvida para retrabalho',
      missionId: mission.id,
    });
    const pending = suite.handoffs.submit({
      status: 'success',
      summary: 'entrega ainda sem ACK',
      missionId: mission.id,
    });
    expect(xpEvents(runtimeManager, executionScope)).toEqual([]);

    // Recibo main-owned do ACK físico: consumed + veredito na mesma escrita.
    const ack = runtimeManager.open(executionScope).db.prepare(
      `UPDATE handoffs SET delivery_state = 'consumed', consumed_at = ?,
              ack_verdict = ? WHERE id = ?`,
    );
    ack.run(Date.now(), 'accepted', accepted.id);
    ack.run(Date.now(), 'rework', reworked.id);
    suite.handoffs.submit({
      status: 'partial',
      summary: 'mudança que força nova varredura',
    });

    const events = xpEvents(runtimeManager, executionScope);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'handoff_success',
        entityKey: `handoff:${accepted.id}`,
        points: 3_000,
        evidence: null,
      }),
    ]);
    expect(events.some((event) => event.entityKey === `handoff:${reworked.id}`))
      .toBe(false);
    expect(events.some((event) => event.entityKey === `handoff:${pending.id}`))
      .toBe(false);
    const snapshot = service.snapshot(executionScope);
    expect(snapshot.counters.handoff_success).toBe(1);
    expect(snapshot.streakDays).toBe(1);
  });

  it('soma o XP de projetos distintos no resumo global sem ler o banco de outro', () => {
    const runtimeManager = createManager();
    const registry = createRegistry(runtimeManager);
    const ledgerFile = path.join(os.tmpdir(), `nx-gxp-svc-${process.pid}-${Date.now()}.json`);
    const ledger = new GlobalXpLedger({ file: ledgerFile });
    const service = new ProjectGamificationService({
      runtimeManager,
      domainStores: registry,
      broadcast: vi.fn(),
      globalLedger: ledger,
    });
    services.push(service);
    service.start();
    const a = scope('project-a');
    const b = scope('project-b');

    service.recordJarvisAction(a, 'open_terminal', true);
    service.recordMediaGenerated(b, 'image', null);
    const snapA = service.snapshot(a);
    const snapB = service.snapshot(b);

    expect(snapA.powerLevel).toBe(1_500);
    expect(snapB.powerLevel).toBe(1_000);
    expect(snapB.global?.powerLevel).toBe(2_500);
    expect(snapB.global?.projectCount).toBe(2);
    expect(snapB.global?.projects.filter((p) => p.current)).toHaveLength(1);
    expect(JSON.stringify(snapB.global)).not.toContain('/workspace/');
    service.dispose();
    fs.rmSync(ledgerFile, { force: true });
  });

  it('reports today XP and groups bursts of the same kind in the feed', () => {
    const day = new Date(2026, 9, 14, 15, 0, 0).getTime();
    let clock = day - 86_400_000;
    const runtimeManager = createManager();
    const registry = createRegistry(runtimeManager);
    const service = new ProjectGamificationService({
      runtimeManager,
      domainStores: registry,
      broadcast: vi.fn(),
      now: () => clock,
    });
    services.push(service);
    service.start();
    const executionScope = scope();

    service.recordJarvisAction(executionScope, 'open_terminal', true);
    clock = day;
    service.recordAgentTurn(executionScope, 'claude');
    clock = day + 1_000;
    service.recordAgentTurn(executionScope, 'codex');
    clock = day + 2_000;
    service.recordAgentTurn(executionScope, 'mimo-code');
    clock = day + 3_000;
    service.recordMediaGenerated(executionScope, 'image', null);

    const snapshot = service.snapshot(executionScope);
    expect(snapshot.todayXp).toBe(300 * 3 + 1_000);
    expect(snapshot.recent).toEqual([
      expect.objectContaining({ kind: 'media_generated', count: 1, points: 1_000 }),
      expect.objectContaining({
        kind: 'agent_turn',
        count: 3,
        points: 900,
        createdAt: day + 2_000,
      }),
      expect.objectContaining({ kind: 'jarvis_action', count: 1, points: 1_500 }),
    ]);
  });

  it('awards the existing mission green efficiency score from local usage', () => {
    const { runtimeManager, registry, service } = boot();
    const executionScope = scope();
    const suite = registry.forScope(executionScope);
    const mission = suite.missions.create({ title: 'Missão eficiente' });
    suite.missionPanes.record({
      missionId: mission.id,
      adapterId: 'claude',
      effort: 'medium',
    });
    recordCheapUsage(runtimeManager, executionScope, mission.id);
    seedTrustedEvidence(
      runtimeManager,
      executionScope,
      mission.id,
      'evidence-efficient',
    );
    suite.handoffs.submit({
      status: 'success',
      summary: 'implementação verificada da missão',
      missionId: mission.id,
      evidenceIds: ['evidence-efficient'],
    });
    completeMission(suite.missions, mission, ['evidence-efficient']);

    const event = xpEvents(runtimeManager, executionScope).find(
      (candidate) => candidate.entityKey === `mission:${mission.id}`,
    );
    expect(event).toEqual(
      expect.objectContaining({ kind: 'mission_green', points: 37_500 }),
    );
    expect(service.snapshot(executionScope).counters.efficient_mission).toBe(1);
  });

  it('is idempotent and narrates level-up only outside sober mode', () => {
    const { runtimeManager, registry, service, broadcast } = boot();
    const executionScope = scope();
    const suite = registry.forScope(executionScope);

    for (let index = 0; index < 4; index += 1) {
      const mission = suite.missions.create({ title: `Missão ${index}` });
      const evidenceId = `evidence-level-${index}`;
      seedTrustedEvidence(runtimeManager, executionScope, mission.id, evidenceId);
      suite.handoffs.submit({
        status: 'success',
        summary: `entrega verificada ${index}`,
        missionId: mission.id,
        evidenceIds: [evidenceId],
      });
      completeMission(suite.missions, mission, [evidenceId]);
    }
    const beforeDuplicateScan = service.snapshot(executionScope);
    suite.handoffs.submit({
      status: 'partial',
      summary: 'mudança que força nova varredura',
    });

    expect(service.snapshot(executionScope).powerLevel).toBe(
      beforeDuplicateScan.powerLevel,
    );
    expect(service.snapshot(executionScope).tier).toBe('INICIADO');
    expect(narrations(broadcast)).toContain('Subiu para INICIADO.');

    const quiet = boot({ sober: true });
    const quietScope = scope('project-quiet', 'main');
    const quietSuite = quiet.registry.forScope(quietScope);
    const quietMission = quietSuite.missions.create({ title: 'Missão silenciosa' });
    seedTrustedEvidence(
      quiet.runtimeManager,
      quietScope,
      quietMission.id,
      'evidence-quiet',
    );
    quietSuite.handoffs.submit({
      status: 'success',
      summary: 'entrega silenciosa',
      missionId: quietMission.id,
      evidenceIds: ['evidence-quiet'],
    });
    expect(quiet.service.snapshot(quietScope).powerLevel).toBe(8_000);
    expect(narrations(quiet.broadcast)).toEqual([]);
  });

  it('replays existing history once with simple retro weights and no voice', () => {
    const runtimeManager = createManager();
    const registry = createRegistry(runtimeManager);
    const executionScope = scope();
    const suite = registry.forScope(executionScope);
    const mission = suite.missions.create({ title: 'Missão antiga' });
    completeMission(suite.missions, mission);
    seedTrustedEvidence(
      runtimeManager,
      executionScope,
      mission.id,
      'evidence-retro',
    );
    suite.handoffs.submit({
      status: 'success',
      summary: 'entrega histórica com evidência',
      missionId: mission.id,
      evidenceIds: ['evidence-retro'],
    });
    const task = suite.tasks.create({ title: 'Task antiga' });
    suite.tasks.update(task.id, { status: 'done' });

    const { service, broadcast } = createService(runtimeManager, registry);
    const db = runtimeManager.open(executionScope).db;
    const events = listXpEvents(db);
    const byKey = new Map(events.map((event) => [event.entityKey, event]));

    expect(getMeta(db, 'replayDone')).toBe('1');
    expect(byKey.get(`mission:${mission.id}`)).toEqual(
      expect.objectContaining({ kind: 'mission_done', points: 10_000, retro: true }),
    );
    expect(events.find((event) => event.kind === 'handoff_success')?.points)
      .toBe(3_000);
    expect(byKey.get(`task_done:${task.id}`)?.points).toBe(5_000);
    expect(narrations(broadcast)).toEqual([]);

    service.runRetroReplayOnce(executionScope);
    expect(listXpEvents(db)).toHaveLength(events.length);
  });

  it('builds snapshot, achievements and coalesced scope-bearing changes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeManager = createManager();
    const registry = createRegistry(runtimeManager);
    const { service, broadcast } = createService(runtimeManager, registry, {
      agentCategory: (agentName) =>
        agentName === 'revisora' ? 'reviewer' : null,
    });
    const executionScope = scope();
    const suite = registry.forScope(executionScope);
    const mission = suite.missions.create({ title: 'Revisão confiável' });
    seedTrustedEvidence(
      runtimeManager,
      executionScope,
      mission.id,
      'evidence-reviewer',
    );
    suite.handoffs.submit({
      status: 'success',
      summary: 'revisão verde',
      fromAgent: 'revisora',
      missionId: mission.id,
      evidenceIds: ['evidence-reviewer'],
    });
    const task = suite.tasks.create({ title: 'Feature' });
    suite.tasks.update(task.id, { status: 'done' });
    service.recordMediaGenerated(executionScope, 'image', null);
    service.recordJarvisAction(executionScope, 'open_terminal', true);
    service.recordAgentTurn(executionScope, 'claude');

    const snapshot = service.snapshot(executionScope);
    expect(snapshot).toEqual(
      expect.objectContaining({
        // 15_500 previous + 300 agent_turn
        powerLevel: 15_800,
        tier: 'RECRUTA',
        tierFloor: 'RECRUTA',
        nextTierAt: 100_000,
        streakDays: 1,
        shieldsLeft: 2,
        prestige: 0,
        prestigeReady: false,
        ruleVersion: 1,
        projectId: executionScope.projectId,
        checkoutId: executionScope.checkoutId,
        rootRealPath: executionScope.rootRealPath,
      }),
    );
    expect(snapshot.counters.deliveries_reviewer).toBe(1);
    expect(snapshot.counters.media_image).toBe(1);
    expect(snapshot.counters.agent_turn).toBe(1);
    expect(snapshot.recent?.[0]).toEqual(
      expect.objectContaining({ kind: 'agent_turn', points: 300 }),
    );
    expect(snapshot.achievements).toEqual(
      expect.arrayContaining(['primeira-imagem', 'primeiro-comando']),
    );
    expect(service.prestige(executionScope).prestige).toBe(0);

    vi.advanceTimersByTime(1_100);
    expect(broadcast).toHaveBeenCalledWith(
      executionScope,
      GAMIFICATION_CHANNELS.changed,
      expect.objectContaining({ projectId: executionScope.projectId }),
    );
  });

  it('physically isolates projects and checkouts with no process fallback', () => {
    const { runtimeManager, registry, service, broadcast } = boot();
    const scopeA = scope('project-a', 'main');
    const scopeB = scope('project-b', 'main');
    const scopeAFeature = scope('project-a', 'feature');

    const suiteA = registry.forScope(scopeA);
    const missionA = suiteA.missions.create({ title: 'Somente projeto A' });
    seedTrustedEvidence(
      runtimeManager,
      scopeA,
      missionA.id,
      'evidence-project-a',
    );
    suiteA.handoffs.submit({
      status: 'success',
      summary: 'somente projeto A',
      missionId: missionA.id,
      evidenceIds: ['evidence-project-a'],
    });

    expect(service.snapshot(scopeA).powerLevel).toBe(8_000);
    expect(service.snapshot(scopeB).powerLevel).toBe(0);
    expect(service.snapshot(scopeAFeature).powerLevel).toBe(0);
    expect(xpEvents(runtimeManager, scopeB)).toEqual([]);
    expect(xpEvents(runtimeManager, scopeAFeature)).toEqual([]);
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeB).databasePath,
    );
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeAFeature).databasePath,
    );
    expect(
      broadcast.mock.calls
        .filter(([, channel]) => channel === 'voice:narrate')
        .every(([emittedScope]) => emittedScope.projectId === 'project-a'),
    ).toBe(true);
  });

  it('rejects cross-scope profile imports', () => {
    const { registry, service } = boot();
    const scopeA = scope('project-a', 'main');
    const scopeB = scope('project-b', 'main');
    registry.forScope(scopeA).handoffs.submit({
      status: 'success',
      summary: 'perfil do A',
      artifacts: [GREEN_ARTIFACT],
    });

    const exported = service.exportProfile(scopeA);
    expect(service.importProfile(scopeB, exported)).toEqual({
      ok: false,
      error: 'Perfil pertence a outro projeto/checkout ou é inválido.',
    });
    expect(service.snapshot(scopeB).powerLevel).toBe(0);
  });

  it('rolls back XP when derived metadata cannot be persisted', () => {
    const { runtimeManager, service } = boot();
    const executionScope = scope('project-atomic', 'main');
    const db = runtimeManager.open(executionScope).db;
    service.snapshot(executionScope);
    db.exec(`
      CREATE TRIGGER reject_achievements
      BEFORE INSERT ON gamification_meta
      WHEN NEW.key = 'achievements'
      BEGIN
        SELECT RAISE(ABORT, 'derived metadata rejected');
      END;
    `);

    expect(() =>
      service.recordJarvisAction(executionScope, 'open_terminal', true),
    ).toThrow(/derived metadata rejected/i);
    expect(listXpEvents(db)).toEqual([]);
    expect(getMeta(db, 'achievements')).toBeNull();
  });

  it('serves reads but fails every mutation in safe-read-only mode', () => {
    const executionScope = scope('project-safe', 'main');
    const writerManager = createManager();
    const writerRegistry = createRegistry(writerManager);
    const writer = createService(writerManager, writerRegistry).service;
    writer.recordJarvisAction(executionScope, 'open_terminal', true);
    const exported = writer.exportProfile(executionScope);
    expect(writer.snapshot(executionScope).powerLevel).toBe(1_500);
    writer.dispose();
    writerRegistry.dispose();
    writerManager.closeAll();

    const changedFirst = createProjectMigration({
      ...INITIAL_PROJECT_MIGRATIONS[0],
      sql: `${INITIAL_PROJECT_MIGRATIONS[0].sql}\n-- checksum changed`,
    });
    const readerManager = createManager({
      migrations: [changedFirst, ...INITIAL_PROJECT_MIGRATIONS.slice(1)],
    });
    const readerRegistry = createRegistry(readerManager);
    const reader = createService(readerManager, readerRegistry).service;

    expect(readerManager.open(executionScope).mode).toBe('safe-read-only');
    expect(reader.snapshot(executionScope).powerLevel).toBe(1_500);
    expect(reader.exportProfile(executionScope).events).toHaveLength(1);
    expect(() =>
      reader.recordJarvisAction(executionScope, 'open_terminal', true),
    ).toThrow(/safe read-only/i);
    expect(() => reader.recordMediaGenerated(executionScope, 'image', null))
      .toThrow(/safe read-only/i);
    expect(() => reader.selectSkin(executionScope, null)).toThrow(
      /safe read-only/i,
    );
    expect(() => reader.prestige(executionScope)).toThrow(/safe read-only/i);
    expect(() => reader.importProfile(executionScope, exported)).toThrow(
      /safe read-only/i,
    );
  });
});
