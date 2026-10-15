import fs from 'node:fs';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { EventLedger } from './event-ledger';
import { createSqliteEventLedgerStorage } from './sqlite-event-ledger-storage';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ledger-sqlite-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('SQLite event ledger storage', () => {
  it('persists a verified chain across reopen and isolates checkouts', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const ledger = new EventLedger(createSqliteEventLedgerStorage(manager, scope), {
      now: () => 1,
      makeId: () => 'event-a',
    });
    const event = ledger.append({
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      type: 'context-updated',
      actor: { kind: 'nexus', id: 'nexus' },
      payload: { revision: 1 },
      versions: { appVersion: 'test' },
    });
    manager.close(scope);

    expect(createSqliteEventLedgerStorage(manager, scope).list()).toEqual([event]);
    expect(
      createSqliteEventLedgerStorage(
        manager,
        testProjectScope({ checkoutId: 'other-checkout' }),
      ).list(),
    ).toEqual([]);
  });

  it('verifies a growing chain once and advances only through validated appends', () => {
    const queries: string[] = [];
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test',
      databaseFactory: (filename, options) => new Database(filename, {
        ...options, verbose: (query) => queries.push(String(query)),
      }),
    });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    let next = 0;
    const ledger = new EventLedger(storage, { now: () => 1, makeId: () => `event-${++next}` });
    for (let revision = 1; revision <= 40; revision += 1) {
      ledger.append({ projectId: scope.projectId, checkoutId: scope.checkoutId,
        type: 'context-updated', actor: { kind: 'nexus', id: 'nexus' },
        payload: { revision }, versions: { appVersion: 'test' },
      });
      expect(storage.readLast()?.sequence).toBe(revision);
    }
    expect(queries.filter((query) => /SELECT event_json FROM event_ledger ORDER BY sequence/.test(query))).toHaveLength(1);
    const last = storage.readLast()!;
    expect(() => Object.assign(last, { sequence: 0 })).toThrow(TypeError);
    expect(() => Object.assign(last.payload!, { revision: 0 })).toThrow(TypeError);
    // Changes elsewhere in the shared DB conservatively invalidate the prefix.
    manager.open(scope).db.exec('CREATE TABLE cursor_noise (id INTEGER); INSERT INTO cursor_noise VALUES (1)');
    expect(storage.readLast()).toEqual(last);
    expect(queries.filter((query) => /SELECT event_json FROM event_ledger ORDER BY sequence/.test(query))).toHaveLength(2);
    // A new connection/storage must establish its own verified cursor.
    expect(createSqliteEventLedgerStorage(manager, scope).readLast()?.sequence).toBe(40);
  });

  it.each(['same connection', 'other connection'])('invalidates the verified tip after an old link is forged by %s', (connection) => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    let next = 0;
    const ledger = new EventLedger(storage, { now: () => 1, makeId: () => `event-${++next}` });
    const draft = { projectId: scope.projectId, checkoutId: scope.checkoutId,
      type: 'context-updated' as const, actor: { kind: 'nexus' as const, id: 'nexus' },
      payload: { revision: 1 }, versions: { appVersion: 'test' },
    };
    ledger.append(draft);
    ledger.append(draft);
    expect(storage.readLast()?.sequence).toBe(2);
    const runtime = manager.open(scope);
    const db = connection === 'same connection' ? runtime.db : new Database(runtime.databasePath);
    try {
      db.prepare("UPDATE event_ledger SET event_json = replace(event_json, '\"revision\":1', '\"revision\":2') WHERE sequence = 1").run();
      expect(() => storage.readLast()).toThrow(/event ledger/i);
      expect(() => ledger.append(draft)).toThrow(/event ledger/i);
    } finally {
      if (db !== runtime.db) db.close();
    }
  });

  it('invalidates the cursor after replacing an old event while preserving the tip', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    let next = 0;
    const ledger = new EventLedger(storage, { now: () => 1, makeId: () => `event-${++next}` });
    const draft = { projectId: scope.projectId, checkoutId: scope.checkoutId,
      type: 'context-updated' as const, actor: { kind: 'nexus' as const, id: 'nexus' },
      payload: { revision: 1 }, versions: { appVersion: 'test' },
    };
    const first = ledger.append(draft);
    const second = ledger.append(draft);
    storage.readLast();
    const db = manager.open(scope).db;
    db.prepare('DELETE FROM event_ledger WHERE sequence = 1').run();
    db.prepare(`INSERT INTO event_ledger
      (sequence, id, mission_id, event_type, previous_hash, event_hash, event_json, occurred_at)
      VALUES (1, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(first.id, first.type, first.previousHash, first.eventHash,
        JSON.stringify({ ...first, eventHash: 'a'.repeat(64) }), first.occurredAt);
    expect(db.prepare('SELECT event_hash FROM event_ledger WHERE sequence = 2').get())
      .toEqual({ event_hash: second.eventHash });
    expect(() => storage.readLast()).toThrow(/event ledger/i);
  });

  it('never promotes a controlled append when a trigger also changes a previous link', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    let next = 0;
    const ledger = new EventLedger(storage, { now: () => 1, makeId: () => `event-${++next}` });
    const draft = { projectId: scope.projectId, checkoutId: scope.checkoutId,
      type: 'context-updated' as const, actor: { kind: 'nexus' as const, id: 'nexus' },
      payload: { revision: 1 }, versions: { appVersion: 'test' },
    };
    ledger.append(draft);
    const db = manager.open(scope).db;
    db.exec(`CREATE TRIGGER forge_old_event AFTER INSERT ON event_ledger
      WHEN NEW.sequence > 1 BEGIN
        UPDATE event_ledger SET event_json = replace(event_json, '"revision":1', '"revision":2')
        WHERE sequence = 1;
      END`);
    ledger.append(draft);
    expect(() => storage.readLast()).toThrow(/event ledger/i);
  });

  it('reverifies the same storage after its manager closes and reopens the connection', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    const event = new EventLedger(storage, { now: () => 1, makeId: () => 'event-a' }).append({
      projectId: scope.projectId, checkoutId: scope.checkoutId, type: 'context-updated',
      actor: { kind: 'nexus', id: 'nexus' }, payload: { revision: 1 }, versions: { appVersion: 'test' },
    });
    manager.close(scope);
    expect(storage.readLast()).toEqual(event);
  });

  it('does not keep a tip from a rolled-back enclosing transaction', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    let next = 0;
    const ledger = new EventLedger(storage, { now: () => 1, makeId: () => `event-${++next}` });
    const draft = { projectId: scope.projectId, checkoutId: scope.checkoutId,
      type: 'context-updated' as const, actor: { kind: 'nexus' as const, id: 'nexus' },
      payload: { revision: 1 }, versions: { appVersion: 'test' },
    };
    ledger.append(draft);
    expect(() => manager.open(scope).db.transaction(() => {
      ledger.append(draft);
      expect(storage.readLast()?.sequence).toBe(2);
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(storage.readLast()?.sequence).toBe(1);
    expect(ledger.append(draft).sequence).toBe(2);
    const db = manager.open(scope).db;
    db.prepare('DELETE FROM event_ledger WHERE sequence = 1').run();
    expect(() => storage.readLast()).toThrow(/event ledger/i);
  });

  it('fails closed when durable event JSON is tampered', () => {
    const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
    managers.push(manager);
    const scope = testProjectScope();
    const storage = createSqliteEventLedgerStorage(manager, scope);
    new EventLedger(storage, { now: () => 1, makeId: () => 'event-a' }).append({
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      type: 'context-updated',
      actor: { kind: 'nexus', id: 'nexus' },
      payload: { revision: 1 },
      versions: { appVersion: 'test' },
    });
    manager.open(scope).db
      .prepare("UPDATE event_ledger SET event_json = replace(event_json, '\"revision\":1', '\"revision\":2')")
      .run();

    expect(() => storage.list()).toThrow(/event ledger/i);
  });
});
