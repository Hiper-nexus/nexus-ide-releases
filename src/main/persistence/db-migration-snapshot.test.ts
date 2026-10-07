import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DB_SNAPSHOTS,
  dbSnapshotDir,
  pruneDbMigrationSnapshots,
  readDbMigrationState,
  takeDbMigrationSnapshot,
} from './db-migration-snapshot';

const env = vi.hoisted(() => ({ userData: '', version: '9.9.9' }));

vi.mock('electron', () => ({
  app: { getPath: () => env.userData, getVersion: () => env.version },
}));

const tempDirs: string[] = [];

function tempNexusDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-snapshot-'));
  tempDirs.push(dir);
  env.userData = dir;
  return path.join(dir, 'nexus.db');
}

/** nexus.db de uma versão antiga: `squads` sem as colunas migradas, com dados do operador. */
function seedLegacyDb(file: string): void {
  const db = new Database(file);
  db.exec(`CREATE TABLE squads (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL,
    created_at                TEXT NOT NULL,
    builtin                   INTEGER NOT NULL DEFAULT 0,
    orchestrator_instructions TEXT NOT NULL DEFAULT '',
    roster_json               TEXT NOT NULL DEFAULT '[]'
  )`);
  db.prepare('INSERT INTO squads (id, name, created_at) VALUES (?, ?, ?)').run(
    'sq-1',
    'Squad do operador',
    '2026-01-01',
  );
  db.close();
}

function inspect(file: string): { rows: unknown[]; columns: string[] } {
  const db = new Database(file);
  try {
    return {
      rows: db.prepare('SELECT id, name FROM squads ORDER BY id').all(),
      columns: (db.prepare('PRAGMA table_info(squads)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    };
  } finally {
    db.close();
  }
}

function snapshotFiles(file: string): string[] {
  try {
    return fs.readdirSync(dbSnapshotDir(file)).filter((name) => name.endsWith('.db'));
  } catch {
    return [];
  }
}

/** Um boot novo do processo: módulo de db zerado (getDb só inicializa uma vez). */
async function boot(): Promise<typeof import('./db')> {
  vi.resetModules();
  return import('./db');
}

const OPERATOR_ROWS = [{ id: 'sq-1', name: 'Squad do operador' }];

afterEach(() => {
  vi.doUnmock('./schema-migrations');
  vi.restoreAllMocks();
  env.version = '9.9.9';
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('nexus.db snapshot antes de migrar', () => {
  it('migração que lança no meio: restaura o snapshot e o próximo boot sobe com os dados intactos', async () => {
    const file = tempNexusDb();
    seedLegacyDb(file);
    vi.doMock('./schema-migrations', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./schema-migrations')>();
      return {
        ...actual,
        migrateSchema: (db: { exec(sql: string): unknown }) => {
          // Pior caso: mudanças fora de transação e então a falha.
          db.exec("ALTER TABLE squads ADD COLUMN native_instructions TEXT NOT NULL DEFAULT ''");
          db.exec('DELETE FROM squads');
          throw new Error('migração quebrou no meio');
        },
      };
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await boot();
    expect(failed.getDb()).toBeNull();
    expect(failed.isDbDegraded()).toBe(true);
    expect(errors.mock.calls.flat().join('\n')).toContain('restaurado do snapshot');
    // No disco: dados e schema de antes da migração, sem marcador pendente.
    expect(inspect(file)).toEqual({
      rows: OPERATOR_ROWS,
      columns: ['id', 'name', 'created_at', 'builtin', 'orchestrator_instructions', 'roster_json'],
    });
    expect(readDbMigrationState(file)).toBeNull();
    expect(snapshotFiles(file)).toHaveLength(1);

    vi.doUnmock('./schema-migrations');
    const next = await boot();
    const db = next.getDb();
    expect(db).not.toBeNull();
    expect(next.isDbDegraded()).toBe(false);
    expect(db!.prepare('SELECT id, name FROM squads ORDER BY id').all()).toEqual(OPERATOR_ROWS);
    next.closeDb();
    expect(inspect(file).columns).toContain('native_instructions');
  });

  it('processo morto no meio da migração: o próximo boot restaura antes de abrir, mesmo com -wal sobrando', async () => {
    const file = tempNexusDb();
    seedLegacyDb(file);
    const raw = new Database(file);
    raw.exec('PRAGMA journal_mode = WAL');
    takeDbMigrationSnapshot(raw, file, { fromSchema: 0, toSchema: 21, appVersion: '9.9.9' });
    raw.exec("ALTER TABLE squads ADD COLUMN native_instructions TEXT NOT NULL DEFAULT ''");
    raw.exec('DELETE FROM squads');
    // O dano ainda está no -wal; um crash o deixa no disco. Reaplicá-lo sobre o
    // arquivo restaurado ressuscitaria a migração quebrada.
    const wal = fs.readFileSync(`${file}-wal`);
    raw.close();
    fs.writeFileSync(`${file}-wal`, wal);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const next = await boot();
    const db = next.getDb();
    expect(db).not.toBeNull();
    expect(warnings.mock.calls.flat().join('\n')).toContain('caiu no meio da migração');
    expect(db!.prepare('SELECT id, name FROM squads ORDER BY id').all()).toEqual(OPERATOR_ROWS);
    // Restaurado, o banco volta a ter migração pendente: novo snapshot, nova rodada.
    expect(readDbMigrationState(file)?.phase).toBe('migrated');
    expect(snapshotFiles(file)).toHaveLength(2);
    next.closeDb();
    expect(inspect(file).columns).toContain('native_instructions');
  });

  it('sem migração pendente não grava snapshot (instalação nova nem schema já atual)', async () => {
    const file = tempNexusDb();

    const fresh = await boot();
    expect(fresh.getDb()).not.toBeNull();
    fresh.closeDb();
    const current = await boot();
    expect(current.getDb()).not.toBeNull();
    current.closeDb();

    expect(snapshotFiles(file)).toEqual([]);
    expect(fs.existsSync(dbSnapshotDir(file))).toBe(false);
  });

  it('nomeia o snapshot com as versões de schema e do app e grava o boot confirmado', async () => {
    const file = tempNexusDb();
    seedLegacyDb(file);
    env.version = '2.4.0-beta.1+build/7';

    const mod = await boot();
    expect(mod.getDb()).not.toBeNull();
    const [name] = snapshotFiles(file);
    const match = /^nexus-schema-(\d+)-to-(\d+)-app-2\.4\.0-beta\.1_build_7-\d+\.db$/.exec(name);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(Number(match![2]));
    // O snapshot guarda o banco de ANTES da migração.
    expect(inspect(path.join(dbSnapshotDir(file), name)).columns).not.toContain(
      'native_instructions',
    );
    expect(readDbMigrationState(file)).toMatchObject({
      phase: 'migrated',
      snapshot: name,
      appVersion: '2.4.0-beta.1+build/7',
    });

    mod.confirmDbBoot();
    expect(readDbMigrationState(file)).toMatchObject({ phase: 'confirmed', snapshot: name });
    expect(readDbMigrationState(file)?.confirmedAt).toEqual(expect.any(Number));
    mod.closeDb();
  });

  it('snapshot que falha não vira motivo novo de modo degradado: migra como antes', async () => {
    const file = tempNexusDb();
    seedLegacyDb(file);
    fs.writeFileSync(dbSnapshotDir(file), 'não é diretório');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const mod = await boot();
    const db = mod.getDb();
    expect(db).not.toBeNull();
    expect(mod.isDbDegraded()).toBe(false);
    expect(errors.mock.calls.flat().join('\n')).toContain('SEM cópia de segurança');
    expect(db!.prepare('SELECT id, name FROM squads ORDER BY id').all()).toEqual(OPERATOR_ROWS);
    mod.closeDb();
    expect(inspect(file).columns).toContain('native_instructions');
  });
});

describe('retenção dos snapshots', () => {
  it('mantém os mais novos, preserva o rollback ainda não confirmado e não toca em outros arquivos', () => {
    const file = tempNexusDb();
    const dir = dbSnapshotDir(file);
    fs.mkdirSync(dir);
    const names = [1, 2, 3, 4, 5, 6].map(
      (i) => `nexus-schema-20-to-22-app-1.0.${i}-${1_000 + i}.db`,
    );
    for (const name of names) fs.writeFileSync(path.join(dir, name), 'x');
    const staging = 'nexus-schema-20-to-22-app-1.0.9-2000.db.partial';
    fs.writeFileSync(path.join(dir, staging), '');
    fs.writeFileSync(path.join(dir, 'notas-do-operador.txt'), 'não apagar');
    const state = {
      version: 1,
      phase: 'migrated',
      snapshot: names[0],
      appVersion: '1.0.1',
      fromSchema: 20,
      toSchema: 22,
      createdAt: 1_001,
    };
    fs.writeFileSync(path.join(dir, 'migration-state.json'), JSON.stringify(state));

    pruneDbMigrationSnapshots(file);
    expect(snapshotFiles(file).sort()).toEqual(
      [names[0], ...names.slice(-MAX_DB_SNAPSHOTS)].sort(),
    );
    expect(fs.existsSync(path.join(dir, staging))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'notas-do-operador.txt'))).toBe(true);

    fs.writeFileSync(
      path.join(dir, 'migration-state.json'),
      JSON.stringify({ ...state, phase: 'confirmed', confirmedAt: 1_100 }),
    );
    pruneDbMigrationSnapshots(file);
    expect(snapshotFiles(file).sort()).toEqual(names.slice(-MAX_DB_SNAPSHOTS).sort());
  });
});
