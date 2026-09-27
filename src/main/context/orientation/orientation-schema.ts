import path from 'node:path';
import type { OrientationDbEntityKind } from './orientation-types';
import {
  isSqlWord,
  readSqlQualifiedName,
  scanSqlTokens,
  splitSqlStatements,
  type SqlToken,
} from './orientation-sql-scan';

/** One CREATE/ALTER fact extracted from a single schema source file. */
export interface SchemaEntityFact {
  readonly kind: OrientationDbEntityKind;
  readonly qualifiedName: string;
  readonly name: string;
  readonly definedIn: string;
  /** Last explicit ENABLE/DISABLE ROW LEVEL SECURITY in this file, if any. */
  readonly rlsEnabled?: boolean;
  /** Prisma model name (client accessor is its lowerCamel form). */
  readonly modelName?: string;
  /** Variable a drizzle `pgTable(...)` is assigned to. */
  readonly drizzleBinding?: string;
}

const DEFAULT_SCHEMA = 'public';

export function dbNodeId(kind: OrientationDbEntityKind, qualifiedName: string): string {
  return `db:${kind}:${qualifiedName}`;
}

export function qualifyName(schema: string | undefined, name: string): string {
  return `${schema && schema.trim() ? schema : DEFAULT_SCHEMA}.${name}`;
}

function bareName(qualifiedName: string): string {
  const index = qualifiedName.indexOf('.');
  return index >= 0 ? qualifiedName.slice(index + 1) : qualifiedName;
}

/** Skip `CREATE [OR REPLACE] [<modifiers>] <kind>`; returns the index after `kind`, or -1. */
export function matchSqlCreate(
  statement: readonly SqlToken[],
  kind: string,
  modifiers: readonly string[] = [],
): number {
  if (!isSqlWord(statement[0], 'CREATE')) return -1;
  let index = 1;
  if (isSqlWord(statement[index], 'OR') && isSqlWord(statement[index + 1], 'REPLACE')) index += 2;
  while (modifiers.length > 0 && isSqlWord(statement[index], ...modifiers)) index += 1;
  return isSqlWord(statement[index], kind) ? index + 1 : -1;
}

function skipIfExists(statement: readonly SqlToken[], index: number): number {
  if (isSqlWord(statement[index], 'IF') && isSqlWord(statement[index + 1], 'NOT') && isSqlWord(statement[index + 2], 'EXISTS')) {
    return index + 3;
  }
  if (isSqlWord(statement[index], 'IF') && isSqlWord(statement[index + 1], 'EXISTS')) return index + 2;
  return index;
}

/** `ENABLE|DISABLE ROW LEVEL SECURITY` anywhere in an ALTER TABLE statement. */
function rlsToggle(statement: readonly SqlToken[], from: number): boolean | undefined {
  let state: boolean | undefined;
  for (let index = from; index < statement.length; index += 1) {
    if (
      isSqlWord(statement[index], 'ENABLE', 'DISABLE') &&
      isSqlWord(statement[index + 1], 'ROW') &&
      isSqlWord(statement[index + 2], 'LEVEL') &&
      isSqlWord(statement[index + 3], 'SECURITY')
    ) {
      state = isSqlWord(statement[index], 'ENABLE');
    }
  }
  return state;
}

/**
 * Detect CREATE/ALTER TABLE, CREATE FUNCTION, CREATE POLICY and
 * ENABLE/DISABLE ROW LEVEL SECURITY statements in a raw .sql source, using the
 * shared SQL lexer (comments/strings skipped, PostgreSQL case folding).
 * `rlsEnabled` is the last explicit toggle seen in this file, if any.
 */
export function extractSchemaEntitiesFromSql(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const tables = new Map<string, boolean | undefined>();
  const functions = new Set<string>();
  const noteTable = (qualifiedName: string, rls?: boolean) => {
    const previous = tables.get(qualifiedName);
    tables.set(qualifiedName, rls ?? previous);
  };

  for (const statement of splitSqlStatements(scanSqlTokens(content))) {
    let index = matchSqlCreate(statement, 'TABLE', ['UNLOGGED', 'TEMP', 'TEMPORARY', 'GLOBAL', 'LOCAL']);
    if (index >= 0) {
      const name = readSqlQualifiedName(statement, skipIfExists(statement, index));
      if (name) noteTable(name.qualifiedName);
      continue;
    }
    if (isSqlWord(statement[0], 'ALTER') && isSqlWord(statement[1], 'TABLE')) {
      index = skipIfExists(statement, 2);
      if (isSqlWord(statement[index], 'ONLY')) index += 1;
      const name = readSqlQualifiedName(statement, index);
      if (name) noteTable(name.qualifiedName, rlsToggle(statement, name.next));
      continue;
    }
    index = matchSqlCreate(statement, 'POLICY');
    if (index >= 0 && isSqlWord(statement[index + 1], 'ON')) {
      const name = readSqlQualifiedName(statement, index + 2);
      if (name) noteTable(name.qualifiedName);
      continue;
    }
    index = matchSqlCreate(statement, 'FUNCTION');
    if (index >= 0) {
      const name = readSqlQualifiedName(statement, index);
      if (name) functions.add(name.qualifiedName);
    }
  }

  const facts: SchemaEntityFact[] = [];
  for (const [qualifiedName, rls] of tables) {
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
      rlsEnabled: rls,
    }));
  }
  for (const qualifiedName of functions) {
    facts.push(Object.freeze({
      kind: 'function' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
    }));
  }
  return Object.freeze(facts);
}

const PRISMA_MODEL_HEAD_RE = /\bmodel[ \t]+([A-Za-z_]\w*)[ \t]*\{/g;
const PRISMA_MAP_RE = /@@map\(\s*["']([^"']+)["']\s*\)/;

/**
 * Detect `model X { ... @@map("y") }` blocks in a .prisma schema file. The
 * block end is found by a forward scan (no lazy regex), and `modelName` keeps
 * the Prisma model so `prisma.x.*` client calls resolve through `@@map`.
 * Prisma quotes table names, so their case is preserved.
 */
export function extractSchemaEntitiesFromPrisma(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const facts: SchemaEntityFact[] = [];
  PRISMA_MODEL_HEAD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRISMA_MODEL_HEAD_RE.exec(content)) !== null) {
    const bodyStart = PRISMA_MODEL_HEAD_RE.lastIndex;
    const close = content.indexOf('}', bodyStart);
    const bodyEnd = close < 0 ? content.length : close;
    PRISMA_MODEL_HEAD_RE.lastIndex = bodyEnd;
    const modelName = match[1];
    const mapped = PRISMA_MAP_RE.exec(content.slice(bodyStart, bodyEnd))?.[1];
    const qualifiedName = qualifyName(undefined, mapped ?? modelName);
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
      modelName,
    }));
  }
  return Object.freeze(facts);
}

const DRIZZLE_PG_TABLE_RE = /\bpgTable\(\s*['"]([^'"]+)['"]/g;
const DRIZZLE_BINDING_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\(\s*['"]([^'"\n]+)['"]/g;

/**
 * Detect `pgTable('name', ...)` drizzle schema declarations in TS/JS, and the
 * variable each one is bound to (`const users = pgTable('users', ...)`) so
 * `db.select().from(users)` can be resolved back to the table.
 */
export function extractSchemaEntitiesFromDrizzle(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const bindings = new Map<string, string>();
  DRIZZLE_BINDING_RE.lastIndex = 0;
  for (const match of content.matchAll(DRIZZLE_BINDING_RE)) {
    if (!bindings.has(match[2])) bindings.set(match[2], match[1]);
  }
  const facts: SchemaEntityFact[] = [];
  DRIZZLE_PG_TABLE_RE.lastIndex = 0;
  for (const match of content.matchAll(DRIZZLE_PG_TABLE_RE)) {
    const qualifiedName = qualifyName(undefined, match[1]);
    const binding = bindings.get(match[1]);
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
      ...(binding ? { drizzleBinding: binding } : {}),
    }));
  }
  return Object.freeze(facts);
}

const MIGRATION_TIMESTAMP_RE = /^(\d{8,})/;

/**
 * Sort schema source paths so that timestamp-prefixed migrations
 * (e.g. supabase/migrations/20260905121000_x.sql) are processed in the order
 * they were applied, oldest first. Non-timestamped paths sort after, by path.
 */
export function sortSchemaPathsByTimestamp(
  paths: readonly string[],
): readonly string[] {
  const withKey = paths.map((relativePath) => {
    const base = path.posix.basename(relativePath);
    const match = MIGRATION_TIMESTAMP_RE.exec(base);
    return { relativePath, timestamp: match?.[1] ?? null };
  });
  return Object.freeze(
    withKey
      .sort((left, right) => {
        if (left.timestamp && right.timestamp) {
          return (
            left.timestamp.localeCompare(right.timestamp) ||
            left.relativePath.localeCompare(right.relativePath)
          );
        }
        if (left.timestamp) return -1;
        if (right.timestamp) return 1;
        return left.relativePath.localeCompare(right.relativePath);
      })
      .map((item) => item.relativePath),
  );
}

export function isSchemaSqlPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.sql');
}

export function isPrismaSchemaPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.prisma');
}
