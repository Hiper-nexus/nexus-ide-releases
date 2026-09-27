import { scanJsTokens } from './orientation-js-scan';
import { matchSqlCreate, qualifyName } from './orientation-schema';
import {
  extractSqlTableRefs,
  isSqlWord,
  readSqlQualifiedName,
  scanSqlTokens,
  splitSqlStatements,
} from './orientation-sql-scan';
import type { OrientationDbEntityKind } from './orientation-types';

export type DbUsageRelation = 'reads' | 'writes' | 'calls';

/**
 * One code↔schema edge. `from` is either a source file's relativePath (TS/JS
 * usage) or a db node id such as `db:function:public.close_commanda_internal`
 * (intra-SQL edges extracted from a function/trigger body).
 */
export interface DbUsageEdge {
  readonly from: string;
  readonly toKind: OrientationDbEntityKind;
  readonly toQualifiedName: string;
  readonly relation: DbUsageRelation;
  /** `prisma.<accessor>.*` — resolved through the model's @@map when known. */
  readonly prismaModel?: string;
  /** Drizzle table variable — only kept when it resolves to a pgTable(...). */
  readonly drizzleBinding?: string;
}

function edge(
  from: string,
  toKind: OrientationDbEntityKind,
  toQualifiedName: string,
  relation: DbUsageRelation,
): DbUsageEdge {
  return Object.freeze({ from, toKind, toQualifiedName, relation });
}

const SUPABASE_FROM_RE = /\bsupabase\w*\s*\.\s*from\(\s*['"]([^'"]+)['"]\s*\)/gi;
const SUPABASE_RPC_RE = /\bsupabase\w*\s*\.\s*rpc\(\s*['"]([^'"]+)['"]/gi;
const WRITE_VERB_AFTER_FROM_RE = /^\s*\.\s*(insert|update|upsert|delete)\b/i;

function relationAfterFrom(content: string, matchEnd: number): DbUsageRelation {
  const tail = content.slice(matchEnd, matchEnd + 200);
  return WRITE_VERB_AFTER_FROM_RE.test(tail) ? 'writes' : 'reads';
}

// Drizzle query builder: db.select().from(t), .innerJoin(t, ...), db.insert(t),
// db.update(t), db.delete(t). `t` is a variable; the graph resolves it to the
// pgTable(...) it is bound to (see buildDbGraphFromFiles) and drops it if none.
const DRIZZLE_USAGE_RES: readonly (readonly [RegExp, DbUsageRelation])[] = [
  [/\)\s*\.\s*from\(\s*([A-Za-z_$][\w$]*)\s*\)/g, 'reads'],
  [/\.\s*(?:inner|left|right|full|cross)Join\(\s*([A-Za-z_$][\w$]*)\s*,/g, 'reads'],
  [/\.\s*(?:insert|update|delete)\(\s*([A-Za-z_$][\w$]*)\s*\)/g, 'writes'],
];

const SQL_STATEMENT_STARTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'MERGE'];

const PRISMA_CALL_RE =
  /\bprisma\s*\.\s*([A-Za-z_]\w*)\s*\.\s*(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
const PRISMA_READ_VERBS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Extract code→table/function edges from a TS/JS source: supabase.from/rpc,
 * prisma.<model>.<verb>, drizzle builder calls, and raw SQL table references
 * (FROM/INTO/UPDATE/JOIN) inside template literals that start like a statement.
 */
export function extractTsDbUsageEdges(
  relativePath: string,
  content: string,
): readonly DbUsageEdge[] {
  const edges: DbUsageEdge[] = [];

  SUPABASE_FROM_RE.lastIndex = 0;
  for (const match of content.matchAll(SUPABASE_FROM_RE)) {
    const relation = relationAfterFrom(content, (match.index ?? 0) + match[0].length);
    edges.push(edge(relativePath, 'table', qualifyName(undefined, match[1]), relation));
  }

  SUPABASE_RPC_RE.lastIndex = 0;
  for (const match of content.matchAll(SUPABASE_RPC_RE)) {
    edges.push(edge(relativePath, 'function', qualifyName(undefined, match[1]), 'calls'));
  }

  PRISMA_CALL_RE.lastIndex = 0;
  for (const match of content.matchAll(PRISMA_CALL_RE)) {
    const relation: DbUsageRelation = PRISMA_READ_VERBS.has(match[2]) ? 'reads' : 'writes';
    edges.push(Object.freeze({
      ...edge(relativePath, 'table', qualifyName(undefined, match[1]), relation),
      prismaModel: match[1],
    }));
  }

  for (const token of scanJsTokens(content)) {
    if (token.kind !== 'template') continue;
    const sql = scanSqlTokens(token.value);
    // Only templates shaped like a statement: prose such as `loaded from the
    // cache` would otherwise mint high-degree fake tables ("the", "a", ...).
    if (!isSqlWord(sql[0], ...SQL_STATEMENT_STARTS)) continue;
    for (const ref of extractSqlTableRefs(sql)) {
      edges.push(edge(relativePath, 'table', ref.qualifiedName, ref.relation));
    }
  }

  for (const [re, relation] of DRIZZLE_USAGE_RES) {
    re.lastIndex = 0;
    for (const match of content.matchAll(re)) {
      edges.push(Object.freeze({
        ...edge(relativePath, 'table', qualifyName(undefined, match[1]), relation),
        drizzleBinding: match[1],
      }));
    }
  }

  return Object.freeze(edges);
}

/**
 * Extract edges internal to .sql schema sources: table references inside a
 * CREATE FUNCTION body (function→table reads/writes), and the table→function
 * "calls" edge implied by CREATE TRIGGER ... ON table ... EXECUTE FUNCTION fn.
 * Uses the same lexer as the schema detectors, so quoting/case rules match.
 */
export function extractSqlDbUsageEdges(
  _relativePath: string,
  content: string,
): readonly DbUsageEdge[] {
  const edges: DbUsageEdge[] = [];
  for (const statement of splitSqlStatements(scanSqlTokens(content))) {
    let index = matchSqlCreate(statement, 'FUNCTION');
    if (index >= 0) {
      const name = readSqlQualifiedName(statement, index);
      if (!name) continue;
      const functionNodeId = `db:function:${name.qualifiedName}`;
      for (let at = name.next; at < statement.length - 1; at += 1) {
        const body = statement[at + 1];
        if (!isSqlWord(statement[at], 'AS') || body.kind !== 'string') continue;
        for (const ref of extractSqlTableRefs(scanSqlTokens(body.value))) {
          edges.push(edge(functionNodeId, 'table', ref.qualifiedName, ref.relation));
        }
        break;
      }
      continue;
    }
    index = matchSqlCreate(statement, 'TRIGGER', ['CONSTRAINT']);
    if (index < 0) continue;
    let table: string | null = null;
    for (let at = index + 1; at < statement.length; at += 1) {
      if (!table && isSqlWord(statement[at], 'ON')) {
        table = readSqlQualifiedName(statement, at + 1)?.qualifiedName ?? null;
      } else if (
        table &&
        isSqlWord(statement[at], 'EXECUTE') &&
        isSqlWord(statement[at + 1], 'PROCEDURE', 'FUNCTION')
      ) {
        const fn = readSqlQualifiedName(statement, at + 2);
        if (fn) edges.push(edge(`db:table:${table}`, 'function', fn.qualifiedName, 'calls'));
        break;
      }
    }
  }
  return Object.freeze(edges);
}
