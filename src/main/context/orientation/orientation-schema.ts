import path from 'node:path';
import type { OrientationDbEntityKind } from './orientation-types';

/** One CREATE/ALTER fact extracted from a single schema source file. */
export interface SchemaEntityFact {
  readonly kind: OrientationDbEntityKind;
  readonly qualifiedName: string;
  readonly name: string;
  readonly definedIn: string;
  readonly rlsEnabled?: boolean;
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

const IDENT = `[A-Za-z_]\\w*`;
const QUALIFIED_IDENT = `(?:"?(${IDENT})"?\\.)?"?(${IDENT})"?`;

const CREATE_TABLE_RE = new RegExp(
  `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED_IDENT}`,
  'gi',
);
const ALTER_TABLE_RE = new RegExp(
  `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED_IDENT}`,
  'gi',
);
const ENABLE_RLS_RE = new RegExp(
  `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED_IDENT}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
  'gi',
);
const CREATE_POLICY_RE = new RegExp(
  `\\bCREATE\\s+POLICY\\s+"?${IDENT}"?\\s+ON\\s+${QUALIFIED_IDENT}`,
  'gi',
);
const CREATE_FUNCTION_RE = new RegExp(
  `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${QUALIFIED_IDENT}`,
  'gi',
);

/**
 * Detect CREATE/ALTER TABLE, CREATE FUNCTION, CREATE POLICY and
 * ENABLE ROW LEVEL SECURITY statements in a raw .sql source. Deterministic,
 * regex-based (no SQL parser) — good enough to recover node identity and RLS
 * posture without executing anything.
 */
export function extractSchemaEntitiesFromSql(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const facts: SchemaEntityFact[] = [];
  const rlsQualified = new Set<string>();
  ENABLE_RLS_RE.lastIndex = 0;
  for (const match of content.matchAll(ENABLE_RLS_RE)) {
    rlsQualified.add(qualifyName(match[1], match[2]));
  }

  const tableQualifiedNames = new Set<string>();
  for (const re of [CREATE_TABLE_RE, ALTER_TABLE_RE, CREATE_POLICY_RE]) {
    re.lastIndex = 0;
    for (const match of content.matchAll(re)) {
      tableQualifiedNames.add(qualifyName(match[1], match[2]));
    }
  }
  for (const qualifiedName of tableQualifiedNames) {
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
      rlsEnabled: rlsQualified.has(qualifiedName) ? true : undefined,
    }));
  }

  CREATE_FUNCTION_RE.lastIndex = 0;
  const functionQualifiedNames = new Set<string>();
  for (const match of content.matchAll(CREATE_FUNCTION_RE)) {
    functionQualifiedNames.add(qualifyName(match[1], match[2]));
  }
  for (const qualifiedName of functionQualifiedNames) {
    facts.push(Object.freeze({
      kind: 'function' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
    }));
  }

  return Object.freeze(facts);
}

const PRISMA_MODEL_RE = /\bmodel\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\n\s*\}/g;
const PRISMA_MAP_RE = /@@map\(\s*["']([^"']+)["']\s*\)/;

/** Detect `model X { ... @@map("y") }` blocks in a .prisma schema file. */
export function extractSchemaEntitiesFromPrisma(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const facts: SchemaEntityFact[] = [];
  PRISMA_MODEL_RE.lastIndex = 0;
  for (const match of content.matchAll(PRISMA_MODEL_RE)) {
    const modelName = match[1];
    const body = match[2] ?? '';
    const mapped = PRISMA_MAP_RE.exec(body)?.[1];
    const tableName = mapped ?? modelName;
    const qualifiedName = qualifyName(undefined, tableName);
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
    }));
  }
  return Object.freeze(facts);
}

const DRIZZLE_PG_TABLE_RE = /\bpgTable\(\s*['"]([^'"]+)['"]/g;

/** Detect `pgTable('name', ...)` drizzle schema declarations in TS/JS. */
export function extractSchemaEntitiesFromDrizzle(
  relativePath: string,
  content: string,
): readonly SchemaEntityFact[] {
  const facts: SchemaEntityFact[] = [];
  DRIZZLE_PG_TABLE_RE.lastIndex = 0;
  for (const match of content.matchAll(DRIZZLE_PG_TABLE_RE)) {
    const qualifiedName = qualifyName(undefined, match[1]);
    facts.push(Object.freeze({
      kind: 'table' as const,
      qualifiedName,
      name: bareName(qualifiedName),
      definedIn: relativePath,
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
