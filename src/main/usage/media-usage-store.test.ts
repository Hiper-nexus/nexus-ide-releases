import { describe, expect, it } from 'vitest';
import type { Db } from '../persistence/db';
import {
  initMediaUsageStore,
  insertMediaUsage,
  mediaUsageTotalsByMission,
  mediaUsageTotalsGlobal,
} from './media-usage-store';

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

describe.skipIf(!sqlite)('media-usage-store (SQLite real)', () => {
  function makeDb(): Db {
    const db = new (sqlite as new (file: string) => Db)(':memory:');
    initMediaUsageStore(db);
    return db;
  }

  it('grava gerações e agrega custo global e por missão', () => {
    const db = makeDb();
    insertMediaUsage(
      db,
      {
        kind: 'image',
        provider: 'google-image',
        model: 'gemini-3.1-flash-image-preview',
        path: '/ws/a.png',
        costUsd: 0.039,
        missionId: 'm-1',
      },
      1,
    );
    insertMediaUsage(
      db,
      {
        kind: 'audio',
        provider: 'elevenlabs',
        model: 'eleven_multilingual_v2',
        path: '/ws/b.mp3',
        costUsd: 0.002,
        missionId: 'm-2',
      },
      2,
    );
    // custo desconhecido (vídeo) não quebra a soma
    insertMediaUsage(
      db,
      {
        kind: 'video',
        provider: 'replicate-video',
        model: 'bytedance/seedance-2.0',
        path: '/ws/c.mp4',
        costUsd: null,
        missionId: 'm-1',
      },
      3,
    );

    const global = mediaUsageTotalsGlobal(db);
    expect(global.generations).toBe(3);
    expect(global.costUsd).toBeCloseTo(0.041, 6);

    const m1 = mediaUsageTotalsByMission(db, 'm-1');
    expect(m1.generations).toBe(2);
    expect(m1.costUsd).toBeCloseTo(0.039, 6);
  });

  it('totais vazios quando não há gerações', () => {
    const db = makeDb();
    expect(mediaUsageTotalsGlobal(db)).toEqual({ generations: 0, costUsd: 0 });
  });
});
