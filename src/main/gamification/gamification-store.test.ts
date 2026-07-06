import { describe, expect, it } from 'vitest';
import type { Db } from '../persistence/db';
import type { XpEventInput } from '../../shared/gamification-types';
import {
  countTodaySameBucket,
  dumpMeta,
  getMeta,
  initGamificationStore,
  insertXpEvent,
  listXpEvents,
  replaceProfile,
  setMeta,
} from './gamification-store';

// better-sqlite3 é módulo nativo; rebuildado p/ Electron não carrega no node
// do vitest — os testes de SQL viram skip, não falha (padrão do repo).
let sqlite: (new (file: string) => Db) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite = require('better-sqlite3') as new (file: string) => Db;
  new sqlite(':memory:').close();
} catch {
  sqlite = null;
}

function ev(over: Partial<XpEventInput> = {}): XpEventInput {
  return {
    kind: 'handoff_green',
    entityKey: 'handoff_green:h1',
    effort: 'medium',
    createdAt: 1_000,
    ...over,
  };
}

describe.skipIf(!sqlite)('gamification-store (SQLite real)', () => {
  function makeDb(): Db {
    const db = new (sqlite as new (file: string) => Db)(':memory:');
    initGamificationStore(db);
    return db;
  }

  it('insere evento e lista com pontos e ruleVersion', () => {
    const db = makeDb();
    expect(insertXpEvent(db, ev(), 8_000)).toBe(true);
    const events = listXpEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].points).toBe(8_000);
    expect(events[0].ruleVersion).toBe(1);
    db.close();
  });

  it('idempotência: mesma entityKey não insere duas vezes', () => {
    const db = makeDb();
    expect(insertXpEvent(db, ev(), 8_000)).toBe(true);
    expect(insertXpEvent(db, ev(), 8_000)).toBe(false);
    expect(listXpEvents(db)).toHaveLength(1);
    db.close();
  });

  it('countTodaySameBucket conta só o mesmo dia + mesmo bucket de effort', () => {
    const db = makeDb();
    insertXpEvent(db, ev({ entityKey: 'handoff_green:a', createdAt: 100 }), 1);
    insertXpEvent(db, ev({ entityKey: 'handoff_green:b', createdAt: 200 }), 1);
    insertXpEvent(
      db,
      ev({ entityKey: 'handoff_green:c', createdAt: 300, effort: 'high' }),
      1,
    );
    expect(countTodaySameBucket(db, 'handoff_green', 'medium', 0)).toBe(2);
    expect(countTodaySameBucket(db, 'handoff_green', 'high', 0)).toBe(1);
    db.close();
  });

  it('perfil: dump + replace fazem round-trip; falha faz rollback', () => {
    const db = makeDb();
    insertXpEvent(db, ev(), 8_000);
    setMeta(db, 'prestige', '1');
    const events = listXpEvents(db);
    const meta = dumpMeta(db);
    expect(meta).toEqual({ prestige: '1' });

    const db2 = makeDb();
    replaceProfile(db2, events, meta);
    expect(listXpEvents(db2)).toEqual(events);
    expect(dumpMeta(db2)).toEqual(meta);

    // evento inválido (points objeto) → lança e NADA muda (transação)
    const broken = [{ ...events[0], id: 2, entityKey: 'x', points: {} }];
    expect(() =>
      replaceProfile(db2, broken as unknown as typeof events, meta),
    ).toThrow();
    expect(listXpEvents(db2)).toEqual(events);
    db.close();
    db2.close();
  });

  it('meta: get/set roundtrip com overwrite', () => {
    const db = makeDb();
    expect(getMeta(db, 'streak')).toBeNull();
    setMeta(db, 'streak', JSON.stringify({ streakDays: 3 }));
    expect(JSON.parse(getMeta(db, 'streak')!)).toEqual({ streakDays: 3 });
    setMeta(db, 'streak', 'x');
    expect(getMeta(db, 'streak')).toBe('x');
    db.close();
  });
});
