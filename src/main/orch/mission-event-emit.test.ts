import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  configureMissionEventEmit,
  emitBootstrapProgress,
  emitDriverDecision,
  emitMissionDegradation,
  emitMissionDegradationNudge,
  hasPersistedMissionDegradation,
  resetBootstrapProgressCountersForTests,
} from './mission-event-emit';
import { MissionEventJournal } from './mission-event-journal';
import type { MissionEvent } from '../../shared/mission-events';
import { MISSION_DEGRADATION_PATHS } from './mission-degradation';

let baseDir = '';
let manager: ProjectRuntimeManager;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-emit-'));
  manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
  const scope = testProjectScope();
  manager.open(scope).db
    .prepare(
      `INSERT INTO missions
         (id, title, description, status, squad_id, milestones_json, orch_session_id,
          created_at, updated_at)
       VALUES ('m1', 't', '', 'active', NULL, '[]', NULL, 1, 1)`,
    )
    .run();
  configureMissionEventEmit(manager);
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.missionEventJournal, true);
});

afterEach(() => {
  manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
  configureMissionEventEmit(null);
});

describe('mission event emit (production path)', () => {
  it('appends driver decisions when flag on', () => {
    const ok = emitDriverDecision(
      testProjectScope(),
      'm1',
      'signal-stall',
      'pane quiet',
      'shadow',
      '1:0:signal-stall',
    );
    expect(ok).toBe(true);
    const journal = new MissionEventJournal(manager, testProjectScope());
    const events = journal.projectRecent('m1', 10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.origin).toBe('driver');
  });

  it('dedupes retries with the same logical tick (no wall-clock uniqueness)', () => {
    const tick = '3:1000:signal-stall';
    emitDriverDecision(
      testProjectScope(),
      'm1',
      'signal-stall',
      'pane quiet',
      'shadow',
      tick,
    );
    emitDriverDecision(
      testProjectScope(),
      'm1',
      'signal-stall',
      'pane quiet',
      'shadow',
      tick,
    );
    const journal = new MissionEventJournal(manager, testProjectScope());
    const events = journal.projectRecent('m1', 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.idempotencyKey).not.toMatch(/\d{13}/); // no Date.now ms
  });

  it('persists a named degradation and its nudge/inactivity network', () => {
    const degradation = {
      what: 'contrato PREVC',
      reducedTo: 'caminho simples verificado',
      why: 'o contexto não congelou a tempo',
      recoverable: true,
      path: MISSION_DEGRADATION_PATHS.prevc,
    } as const;

    expect(
      emitMissionDegradation(testProjectScope(), 'm1', degradation, 7),
    ).toBe(true);
    expect(
      emitMissionDegradationNudge(testProjectScope(), 'm1', degradation, 7),
    ).toBe(true);
    expect(
      hasPersistedMissionDegradation(
        testProjectScope(),
        'm1',
        MISSION_DEGRADATION_PATHS.prevc,
        7,
      ),
    ).toBe(true);

    const events = new MissionEventJournal(manager, testProjectScope())
      .projectRecent('m1', 10)
      .filter((event) => event.type === 'custom');
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => (event.payload as { kind: string }).kind),
    ).toEqual(['mission_degraded', 'mission_degraded_nudge']);
    expect((events[1]?.payload as { network: string }).network).toBe(
      'nudge-or-inactivity',
    );
  });

  it('replays the named degradation after the event emitter restarts', () => {
    const degradation = {
      what: 'kickoff',
      reducedTo: 'reentrada por nudge',
      why: 'o aceite não chegou no prazo',
      recoverable: true,
      path: MISSION_DEGRADATION_PATHS.kickoff,
    } as const;
    expect(
      emitMissionDegradation(testProjectScope(), 'm1', degradation, 3),
    ).toBe(true);

    manager.closeAll();
    configureMissionEventEmit(null);
    const restarted = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.15.5',
    });
    manager = restarted;
    configureMissionEventEmit(restarted);

    expect(
      hasPersistedMissionDegradation(
        testProjectScope(),
        'm1',
        MISSION_DEGRADATION_PATHS.kickoff,
        3,
      ),
    ).toBe(true);
    expect(
      hasPersistedMissionDegradation(
        testProjectScope(),
        'm1',
        MISSION_DEGRADATION_PATHS.kickoff,
        4,
      ),
    ).toBe(false);
  });
});

describe('bootstrap progress telemetry', () => {
  const progressOf = (events: readonly MissionEvent[]) =>
    events.filter(
      (event) =>
        (event.payload as Record<string, unknown> | undefined)?.kind ===
        'bootstrap_progress',
    );

  it('appends a bootstrap_progress custom event carrying the step', () => {
    resetBootstrapProgressCountersForTests();
    emitBootstrapProgress(testProjectScope(), 'm1', 'squad_sealed');
    const journal = new MissionEventJournal(manager, testProjectScope());
    const events = progressOf(journal.projectRecent('m1', 10));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('custom');
    expect(
      (events[0]?.payload as Record<string, unknown>).step,
    ).toBe('squad_sealed');
  });

  it('keeps repeated steps of successive recovery attempts visible', () => {
    resetBootstrapProgressCountersForTests();
    emitBootstrapProgress(testProjectScope(), 'm1', 'plan_baseline');
    emitBootstrapProgress(testProjectScope(), 'm1', 'plan_baseline');
    const journal = new MissionEventJournal(manager, testProjectScope());
    expect(progressOf(journal.projectRecent('m1', 10))).toHaveLength(2);
  });

  it('never throws when the journal is unconfigured', () => {
    configureMissionEventEmit(null);
    expect(() =>
      emitBootstrapProgress(testProjectScope(), 'm1', 'pane_spawned'),
    ).not.toThrow();
  });
});
