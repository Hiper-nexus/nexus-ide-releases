import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  createMissionEventFixture,
  MissionEventJournal,
} from './mission-event-journal';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function seedMission(
  manager: ProjectRuntimeManager,
  missionId: string,
): void {
  const scope = testProjectScope();
  const db = manager.open(scope).db;
  db.prepare(
    `INSERT INTO missions
       (id, title, description, status, squad_id, milestones_json, orch_session_id,
        created_at, updated_at)
     VALUES (?, 't', '', 'active', NULL, '[]', NULL, 1, 1)`,
  ).run(missionId);
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mevt-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('MissionEventJournal', () => {
  it('appends monotonically, dedupes by idempotency key, and replays', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    const scope = testProjectScope();
    seedMission(manager, 'mission-fixture');
    let idSeq = 0;
    const journal = new MissionEventJournal(manager, scope, {
      now: () => 1000,
      idFactory: (prefix) => `${prefix}-${++idSeq}`,
    });

    const a = journal.append(
      createMissionEventFixture({
        idempotencyKey: 'idem-aaaa-bbbb',
        type: 'mission.run_started',
      }),
    );
    const dup = journal.append(
      createMissionEventFixture({
        idempotencyKey: 'idem-aaaa-bbbb',
        type: 'mission.run_started',
      }),
    );
    const b = journal.append(
      createMissionEventFixture({
        idempotencyKey: 'idem-cccc-dddd',
        type: 'agent.spawned',
        parentRunId: 'run-parent',
      }),
    );

    expect(a.sequence).toBe(1);
    expect(dup.sequence).toBe(1);
    expect(dup.id).toBe(a.id);
    expect(b.sequence).toBe(2);
    expect(b.parentRunId).toBe('run-parent');

    const replay = journal.replay({
      missionId: 'mission-fixture',
      afterSequence: 0,
      limit: 10,
    });
    expect(replay.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('advances consumer cursor and acks delivery', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope(), {
      now: () => 2000,
    });

    journal.append(
      createMissionEventFixture({ idempotencyKey: 'idem-1111-2222' }),
    );
    journal.append(
      createMissionEventFixture({ idempotencyKey: 'idem-3333-4444' }),
    );

    journal.markDelivered('mission-fixture', 2);
    const cursor = journal.ack('ui-main', 'mission-fixture', 2);
    expect(cursor.lastSequence).toBe(2);

    const projected = journal.projectRecent('mission-fixture', 10);
    expect(projected.every((e) => e.deliveryStatus === 'acked')).toBe(true);

    // Monotonic: cannot move cursor backwards.
    const same = journal.ack('ui-main', 'mission-fixture', 1);
    expect(same.lastSequence).toBe(2);
  });

  it('rejects an ack beyond the last persisted sequence', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope(), {
      now: () => 3000,
    });

    journal.append(
      createMissionEventFixture({ idempotencyKey: 'idem-5555-6666' }),
    );

    expect(() => journal.ack('ui-main', 'mission-fixture', 1_000_000)).toThrow(
      /exceeds last persisted sequence/i,
    );
    // Cursor unchanged — future events 2, 3, … are still replayable.
    expect(journal.getCursor('ui-main', 'mission-fixture').lastSequence).toBe(0);
    const valid = journal.ack('ui-main', 'mission-fixture', 1);
    expect(valid.lastSequence).toBe(1);
  });

  it('rejects oversized payloads', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope());
    const big = 'x'.repeat(70_000);
    expect(() =>
      journal.append(
        createMissionEventFixture({
          idempotencyKey: 'idem-big-payload',
          payload: { blob: big },
        }),
      ),
    ).toThrow(/payload exceeds size limit/);
  });
});
