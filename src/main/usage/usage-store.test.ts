import { describe, expect, it } from 'vitest';
import type { Db } from '../persistence/db';
import type { UsageEvent } from './claude-transcript';
import {
  computeRealCost,
  initUsageStore,
  recordUsage,
  usageBreakdownByModel,
  usageTotalsBySession,
  usageTotalsGlobal,
} from './usage-store';

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    model: 'claude-sonnet-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    timestamp: 1_000,
    ...overrides,
  };
}

describe('computeRealCost', () => {
  it('aplica preço de input/output do modelo', () => {
    // claude-sonnet: $3/M input, $15/M output.
    expect(computeRealCost(makeEvent())).toBeCloseTo(18, 6);
  });

  it('aplica as razões de cache (read 0.1×, write 5m 1.25×, 1h 2×)', () => {
    const ev = makeEvent({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    // input $3/M → 0.3 + 3.75 + 6 = 10.05
    expect(computeRealCost(ev)).toBeCloseTo(10.05, 6);
  });
});

// better-sqlite3 é módulo nativo; quando rebuildado para o Electron ele não
// carrega no node do vitest — os testes de SQL viram skip, não falha.
let sqlite: (new (file: string) => Db) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite = require('better-sqlite3') as new (file: string) => Db;
  new sqlite(':memory:').close();
} catch {
  sqlite = null;
}

describe.skipIf(!sqlite)('usage-store (SQLite real)', () => {
  function makeDb(): Db {
    const db = new (sqlite as new (file: string) => Db)(':memory:');
    initUsageStore(db);
    return db;
  }

  it('grava e agrega uso por sessão', () => {
    const db = makeDb();
    recordUsage(db, { ...makeEvent(), workspacePath: '/ws' }, 1);
    recordUsage(
      db,
      { ...makeEvent({ messageId: 'msg-2', outputTokens: 500_000 }), workspacePath: '/ws' },
      2,
    );
    const totals = usageTotalsBySession(db, 'sess-1');
    expect(totals.turns).toBe(2);
    expect(totals.outputTokens).toBe(1_500_000);
    db.close();
  });

  it('dedupe last-wins por (session_id, message_id)', () => {
    const db = makeDb();
    recordUsage(db, makeEvent({ outputTokens: 10 }), 1);
    recordUsage(db, makeEvent({ outputTokens: 999 }), 2); // mesmo msg-1: regravado
    const totals = usageTotalsBySession(db, 'sess-1');
    expect(totals.turns).toBe(1);
    expect(totals.outputTokens).toBe(999);
    db.close();
  });

  it('message_id null insere sempre (fora do índice único)', () => {
    const db = makeDb();
    recordUsage(db, makeEvent({ messageId: null, outputTokens: 1 }), 1);
    recordUsage(db, makeEvent({ messageId: null, outputTokens: 2 }), 2);
    expect(usageTotalsBySession(db, 'sess-1').turns).toBe(2);
    db.close();
  });

  it('breakdown por modelo e total global', () => {
    const db = makeDb();
    recordUsage(db, makeEvent(), 1);
    recordUsage(db, makeEvent({ messageId: 'm2', model: 'claude-haiku-4' }), 2);
    const models = usageBreakdownByModel(db).map((r) => r.model);
    expect(models.sort()).toEqual(['claude-haiku-4', 'claude-sonnet-5']);
    expect(usageTotalsGlobal(db).turns).toBe(2);
    db.close();
  });
});
