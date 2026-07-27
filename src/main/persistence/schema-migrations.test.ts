import { describe, expect, it } from 'vitest';
import { migrateSchema, type MigrationDb } from './schema-migrations';

function fakeDb(initial: Record<string, string[]>, failColumn?: string) {
  const columns = new Map(
    Object.entries(initial).map(([table, names]) => [table, new Set(names)]),
  );
  const calls: string[] = [];
  const db: MigrationDb = {
    exec(sql) {
      calls.push(sql);
      const match = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/);
      if (!match) return;
      const [, table, column] = match;
      if (column === failColumn) throw new Error(`cannot add ${column}`);
      columns.get(table)?.add(column);
    },
    prepare(sql) {
      const table = sql.match(/^PRAGMA table_info\((\w+)\)$/)?.[1] ?? '';
      return {
        all: () => [...(columns.get(table) ?? [])].map((name) => ({ name })),
      };
    },
  };
  return { db, calls, columns };
}

describe('migrateSchema', () => {
  it('adds only missing columns and verifies them in one transaction', () => {
    const { db, calls, columns } = fakeDb({
      squads: [],
      mission_panes: ['effort'],
      provider_pane_sessions: [
        'installation_id',
        'project_id',
        'checkout_id',
        'pane_id',
        'adapter_id',
      ],
    });

    migrateSchema(db);

    expect(columns.get('squads')).toContain('native_instructions');
    expect(columns.get('squads')).toContain('runtime_source_squad_id');
    expect(columns.get('squads')).toContain('runtime_source_squad_hash');
    expect(columns.get('mission_panes')).toEqual(
      new Set([
        'effort',
        'pane_id',
        'account_id',
        'scope_json',
        'allowed_tools_json',
        'allowed_skills_json',
      ]),
    );
    expect(columns.get('provider_pane_sessions')).toContain('account_id');

    expect(calls.at(0)).toBe('BEGIN IMMEDIATE');
    expect(calls.at(-1)).toBe('COMMIT');
  });

  it('rolls back and exposes a real migration failure', () => {
    const { db, calls } = fakeDb(
      { squads: [], mission_panes: [] },
      'account_id',
    );

    expect(() => migrateSchema(db)).toThrow('cannot add account_id');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('does not alter a schema that is already current', () => {
    const { db, calls } = fakeDb({
      squads: [
        'native_instructions',
        'runtime_source_squad_id',
        'runtime_source_squad_hash',
      ],
      mission_panes: [
        'effort',
        'pane_id',
        'account_id',
        'scope_json',
        'allowed_tools_json',
        'allowed_skills_json',
      ],
      provider_pane_sessions: ['account_id'],
    });

    migrateSchema(db);

    expect(calls.filter((sql) => sql.startsWith('ALTER TABLE'))).toEqual([]);
  });
});
