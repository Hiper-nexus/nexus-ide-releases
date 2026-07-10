import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { TranscriptStore } from './transcript-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(
  options: Partial<ConstructorParameters<typeof ProjectRuntimeManager>[0]> = {},
): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
    ...options,
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transcripts-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('TranscriptStore project runtime persistence', () => {
  it('persists final rows in order and preserves the renderer record contract', () => {
    const scope = testProjectScope();
    const store = new TranscriptStore(manager(), scope, {
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      idFactory: () => 'voice-transcript-1',
    });

    expect(
      store.append('session-1', {
        role: 'user',
        text: 'partial',
        final: false,
      }),
    ).toBeNull();
    const first = store.append('session-1', {
      role: 'user',
      text: 'abra o package.json',
      final: true,
    });

    expect(first).toEqual({
      id: 'voice-transcript-1',
      sessionId: 'session-1',
      sequence: 1,
      ts: '2026-07-07T12:00:00.000Z',
      role: 'user',
      text: 'abra o package.json',
      audio_url: null,
      final: true,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(store.list('session-1')).toEqual([first]);
  });

  it('truncates text and prunes expired rows inside the append transaction', () => {
    let now = new Date('2026-07-05T12:00:00.000Z');
    let id = 0;
    const store = new TranscriptStore(manager(), testProjectScope(), {
      now: () => now,
      idFactory: () => `voice-transcript-${++id}`,
      maxTextChars: 12,
      retentionDays: 1,
    });
    store.append('expired-session', {
      role: 'user',
      text: 'registro antigo',
      final: true,
    });
    now = new Date('2026-07-07T12:00:00.000Z');

    const current = store.append('current-session', {
      role: 'assistant',
      text: 'abcdefghijklmnopqrstuvwxyz',
      final: true,
      audio_url: 'nexus://audio/current.wav',
    });

    expect(current?.text).toBe('abcdefghijkl');
    expect(current?.audio_url).toBe('nexus://audio/current.wav');
    expect(store.list('expired-session')).toEqual([]);
    expect(store.list('current-session')).toEqual([current]);
  });

  it('physically isolates equal session and row ids across projects/checkouts', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'main',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'main',
      rootRealPath: '/workspace/b',
    });
    const scopeAFeature = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'feature',
      rootRealPath: '/workspace/a-feature',
    });
    const options = {
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      idFactory: () => 'same-row-id',
    };
    const storeA = new TranscriptStore(runtimeManager, scopeA, options);
    const storeB = new TranscriptStore(runtimeManager, scopeB, options);
    const storeAFeature = new TranscriptStore(
      runtimeManager,
      scopeAFeature,
      options,
    );

    storeA.append('same-session', {
      role: 'user',
      text: 'Project A',
      final: true,
    });
    storeB.append('same-session', {
      role: 'user',
      text: 'Project B',
      final: true,
    });

    expect(storeA.list('same-session')[0].text).toBe('Project A');
    expect(storeB.list('same-session')[0].text).toBe('Project B');
    expect(storeAFeature.list('same-session')).toEqual([]);
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeB).databasePath,
    );
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeAFeature).databasePath,
    );
  });

  it('continues sequence from SQLite after manager restart', () => {
    const scope = testProjectScope({ checkoutId: 'restart' });
    const firstManager = manager();
    new TranscriptStore(firstManager, scope, {
      idFactory: () => 'before-restart',
    }).append('durable-session', {
      role: 'user',
      text: 'before',
      final: true,
    });
    firstManager.closeAll();

    const secondManager = manager();
    const afterRestart = new TranscriptStore(secondManager, scope, {
      idFactory: () => 'after-restart',
    });
    const second = afterRestart.append('durable-session', {
      role: 'assistant',
      text: 'after',
      final: true,
    });

    expect(second?.sequence).toBe(2);
    expect(afterRestart.list('durable-session').map((row) => row.text)).toEqual([
      'before',
      'after',
    ]);
  });

  it('coordinates independent facades through SQLite, not process memory', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'concurrent-facades' });
    let id = 0;
    const options = { idFactory: () => `entry-${++id}` };
    const first = new TranscriptStore(runtimeManager, scope, options);
    const second = new TranscriptStore(runtimeManager, scope, options);

    for (let index = 0; index < 20; index += 1) {
      (index % 2 === 0 ? first : second).append('shared-session', {
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: String(index),
        final: true,
      });
    }

    expect(first.list('shared-session').map((row) => row.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('fails a primary-id collision atomically without corrupting either session', () => {
    const store = new TranscriptStore(manager(), testProjectScope(), {
      idFactory: () => 'colliding-id',
    });
    store.append('session-a', {
      role: 'user',
      text: 'kept',
      final: true,
    });

    expect(() =>
      store.append('session-b', {
        role: 'assistant',
        text: 'must rollback',
        final: true,
      }),
    ).toThrow(/unique|constraint/i);
    expect(store.list('session-a').map((row) => row.text)).toEqual(['kept']);
    expect(store.list('session-b')).toEqual([]);
  });

  it('allows reads but blocks append in engine-enforced safe-read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only-transcript' });
    const writable = manager();
    new TranscriptStore(writable, scope, {
      idFactory: () => 'persisted-row',
    }).append('session-read-only', {
      role: 'user',
      text: 'persisted',
      final: true,
    });
    writable.closeAll();
    const firstMigration = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      ...firstMigration,
      sql: `${firstMigration.sql}\n-- force checksum mismatch`,
    });
    const safeReadOnly = manager({
      migrations: [changed, ...INITIAL_PROJECT_MIGRATIONS.slice(1)],
    });
    const store = new TranscriptStore(safeReadOnly, scope, {
      idFactory: () => 'forbidden-row',
    });

    expect(safeReadOnly.open(scope).mode).toBe('safe-read-only');
    expect(store.list('session-read-only').map((row) => row.text)).toEqual([
      'persisted',
    ]);
    expect(() =>
      store.append('session-read-only', {
        role: 'assistant',
        text: 'forbidden',
        final: true,
      }),
    ).toThrow(/safe read-only/i);
  });

  it('fails closed when the project runtime is unavailable', () => {
    const unavailable = manager({
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    const store = new TranscriptStore(unavailable, testProjectScope());

    expect(() => store.list('session-unavailable')).toThrow(
      /no persistence fallback/i,
    );
    expect(() =>
      store.append('session-unavailable', {
        role: 'user',
        text: 'must not survive',
        final: true,
      }),
    ).toThrow(/no persistence fallback/i);
  });
});
