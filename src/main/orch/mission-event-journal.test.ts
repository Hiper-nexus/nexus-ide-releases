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

  it('rejects conflicting reuse of an idempotency key', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope());
    journal.append(createMissionEventFixture({
      idempotencyKey: 'idem-conflict-key',
      type: 'driver.tick',
      payload: { attempt: 1 },
    }));
    expect(() => journal.append(createMissionEventFixture({
      idempotencyKey: 'idem-conflict-key',
      type: 'agent.spawned',
      payload: { attempt: 2 },
    }))).toThrow(/idempotency.*conflict/i);
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

  function journalWith(count: number, payload: (n: number) => Record<string, unknown> = (n) => ({ n })) {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope());
    for (let n = 1; n <= count; n += 1) {
      journal.append(createMissionEventFixture({ idempotencyKey: `idem-orc10-${n}`, payload: payload(n) }));
    }
    return journal;
  }

  it('ORC-10: abaixo do teto o replay limitado é idêntico ao replay atual', () => {
    const journal = journalWith(130);
    for (const query of [
      { missionId: 'mission-fixture', afterSequence: 2, limit: 1000 },
      { missionId: 'mission-fixture', afterSequence: 3, limit: 5 },
      { missionId: 'mission-fixture', afterSequence: 130, limit: 100 },
      { missionId: 'mission-fixture', afterSequence: 10, limit: 100, runId: 'run-fixture' },
    ]) {
      expect(journal.replayBounded(query)).toEqual({ mode: 'replay', events: journal.replay(query) });
    }
    expect(journal.replayBounded({ missionId: 'mission-fixture', afterSequence: 2, limit: 1000 }).events)
      .toHaveLength(128);
  });

  it('ORC-10: acima do teto de eventos devolve snapshot + cursor, não o histórico', () => {
    const journal = journalWith(130);
    const result = journal.replayBounded({ missionId: 'mission-fixture', afterSequence: 1, limit: 1000 });
    expect(result.mode).toBe('snapshot');
    if (result.mode !== 'snapshot') return;
    expect(result.cursor).toBe(130);
    expect(result.hasMoreHistory).toBe(true);
    expect(result.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: 50 }, (_, i) => 81 + i),
    );
    // Cursor velho (além da maior sequência) também recebe snapshot atual.
    const stale = journal.replayBounded({ missionId: 'mission-fixture', afterSequence: 999, limit: 100 });
    expect(stale).toMatchObject({ mode: 'snapshot', cursor: 130 });
  });

  it('ORC-10: acima do teto de bytes o snapshot também cabe em 1 MiB', () => {
    const journal = journalWith(20, (n) => ({ n, blob: 'x'.repeat(60_000) }));
    const result = journal.replayBounded({ missionId: 'mission-fixture', afterSequence: 0, limit: 1000 });
    expect(result.mode).toBe('snapshot');
    if (result.mode !== 'snapshot') return;
    expect(result.cursor).toBe(20);
    expect(result.events.at(-1)?.sequence).toBe(20);
    expect(result.events.length).toBeLessThan(20);
    expect(result.hasMoreHistory).toBe(true);
    const bytes = result.events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0);
    expect(bytes).toBeLessThanOrEqual(1_048_576);
  });

  it('lists raw session_spawned payloads in append order', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: '0.15.5' });
    managers.push(manager);
    seedMission(manager, 'mission-fixture');
    const journal = new MissionEventJournal(manager, testProjectScope());
    journal.append(createMissionEventFixture({
      idempotencyKey: 'idem-spawn-first',
      type: 'observer.session_spawned',
      payload: { frameSeq: 1, sessionId: 'pty-1', paneId: 'pane-1' },
    }));
    journal.append(createMissionEventFixture({
      idempotencyKey: 'idem-other-type',
      type: 'observer.turn_started',
      payload: { frameSeq: 2, sessionId: 'pty-1', paneId: 'pane-1' },
    }));
    journal.append(createMissionEventFixture({
      idempotencyKey: 'idem-spawn-second',
      type: 'observer.session_spawned',
      payload: { frameSeq: 1, sessionId: 'pty-2', paneId: 'pane-1' },
    }));
    const payloads = journal.listSessionSpawnedPayloads('mission-fixture');
    expect(payloads).toHaveLength(2);
    expect(JSON.parse(payloads[0]!)).toMatchObject({ sessionId: 'pty-1', paneId: 'pane-1' });
    expect(JSON.parse(payloads[1]!)).toMatchObject({ sessionId: 'pty-2', paneId: 'pane-1' });
    expect(journal.listSessionSpawnedPayloads('mission-absent')).toEqual([]);
  });
});
