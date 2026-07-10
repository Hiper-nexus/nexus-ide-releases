import fs from 'node:fs';
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
