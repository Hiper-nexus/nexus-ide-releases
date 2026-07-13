export interface MigrationStatement {
  all(...params: unknown[]): unknown[];
}

export interface MigrationDb {
  exec(sql: string): unknown;
  prepare(sql: string): MigrationStatement;
}

interface AddColumnMigration {
  table: 'squads' | 'mission_panes' | 'provider_pane_sessions';
  column: string;
  definition: string;
}

const ADD_COLUMN_MIGRATIONS: AddColumnMigration[] = [
  {
    table: 'squads',
    column: 'native_instructions',
    definition: "native_instructions TEXT NOT NULL DEFAULT ''",
  },
  { table: 'mission_panes', column: 'effort', definition: 'effort TEXT' },
  { table: 'mission_panes', column: 'pane_id', definition: 'pane_id TEXT' },
  { table: 'mission_panes', column: 'account_id', definition: 'account_id TEXT' },
  { table: 'mission_panes', column: 'scope_json', definition: 'scope_json TEXT' },
  {
    table: 'mission_panes',
    column: 'allowed_tools_json',
    definition: 'allowed_tools_json TEXT',
  },
  {
    table: 'mission_panes',
    column: 'allowed_skills_json',
    definition: 'allowed_skills_json TEXT',
  },
  // Exact provider resume must not cross accounts (session ids are account-owned).
  {
    table: 'provider_pane_sessions',
    column: 'account_id',
    definition: 'account_id TEXT',
  },
];

function columnNames(db: MigrationDb, table: AddColumnMigration['table']): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows
      .map((row) => (typeof row.name === 'string' ? row.name : ''))
      .filter(Boolean),
  );
}

function ensureColumn(db: MigrationDb, migration: AddColumnMigration): void {
  if (columnNames(db, migration.table).has(migration.column)) return;
  db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.definition}`);
  if (!columnNames(db, migration.table).has(migration.column)) {
    throw new Error(
      `SQLite migration did not create ${migration.table}.${migration.column}`,
    );
  }
}

/** Additive SQLite migrations are atomic and verified instead of catch-all ignored. */
export function migrateSchema(db: MigrationDb): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of ADD_COLUMN_MIGRATIONS) ensureColumn(db, migration);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the migration error; rollback failure is secondary.
    }
    throw error;
  }
}
