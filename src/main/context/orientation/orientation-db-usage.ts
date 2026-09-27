import { qualifyName } from './orientation-schema';
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

const TEMPLATE_LITERAL_RE = /`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g;
const SQL_TABLE_REF_RE = /\b(FROM|INTO|UPDATE|JOIN)\s+"?([A-Za-z_][\w.]*)"?/gi;

function relationForSqlKeyword(keyword: string): DbUsageRelation {
  return /^(?:INTO|UPDATE)$/i.test(keyword) ? 'writes' : 'reads';
}

/** `raw` may already be schema-qualified (contains a dot) from the regex capture. */
function qualifyRawSqlRef(raw: string): string {
  return raw.includes('.') ? raw : qualifyName(undefined, raw);
}

/**
 * Extract code→table/function edges from a TS/JS source: supabase.from/rpc,
 * prisma.<model>.<verb>, and raw SQL keywords (FROM/INTO/UPDATE/JOIN) found
 * inside template-literal strings.
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
    edges.push(edge(relativePath, 'table', qualifyName(undefined, match[1]), relation));
  }

  TEMPLATE_LITERAL_RE.lastIndex = 0;
  for (const literal of content.matchAll(TEMPLATE_LITERAL_RE)) {
    SQL_TABLE_REF_RE.lastIndex = 0;
    for (const tableMatch of literal[0].matchAll(SQL_TABLE_REF_RE)) {
      edges.push(
        edge(
          relativePath,
          'table',
          qualifyRawSqlRef(tableMatch[2]),
          relationForSqlKeyword(tableMatch[1]),
        ),
      );
    }
  }

  return Object.freeze(edges);
}

const IDENT = `[A-Za-z_]\\w*`;
const QUALIFIED_IDENT = `(?:"?(${IDENT})"?\\.)?"?(${IDENT})"?`;
const CREATE_FUNCTION_BODY_RE = new RegExp(
  `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${QUALIFIED_IDENT}\\s*\\([^)]*\\)[\\s\\S]*?\\bAS\\s+(\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\3`,
  'gi',
);
const CREATE_TRIGGER_FULL_RE = new RegExp(
  `\\bCREATE\\s+TRIGGER\\s+"?${IDENT}"?\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+[\\s\\S]*?\\bON\\s+${QUALIFIED_IDENT}[\\s\\S]*?\\bEXECUTE\\s+(?:PROCEDURE|FUNCTION)\\s+${QUALIFIED_IDENT}`,
  'gi',
);

/**
 * Extract edges internal to .sql schema sources: table references inside a
 * CREATE FUNCTION body (function→table reads/writes), and the table→function
 * "calls" edge implied by CREATE TRIGGER ... ON table ... EXECUTE FUNCTION fn.
 */
export function extractSqlDbUsageEdges(
  _relativePath: string,
  content: string,
): readonly DbUsageEdge[] {
  const edges: DbUsageEdge[] = [];

  CREATE_FUNCTION_BODY_RE.lastIndex = 0;
  for (const match of content.matchAll(CREATE_FUNCTION_BODY_RE)) {
    const functionQualifiedName = qualifyName(match[1], match[2]);
    const functionNodeId = `db:function:${functionQualifiedName}`;
    const body = match[4] ?? '';
    SQL_TABLE_REF_RE.lastIndex = 0;
    for (const tableMatch of body.matchAll(SQL_TABLE_REF_RE)) {
      edges.push(
        edge(
          functionNodeId,
          'table',
          qualifyRawSqlRef(tableMatch[2]),
          relationForSqlKeyword(tableMatch[1]),
        ),
      );
    }
  }

  CREATE_TRIGGER_FULL_RE.lastIndex = 0;
  for (const match of content.matchAll(CREATE_TRIGGER_FULL_RE)) {
    const tableQualifiedName = qualifyName(match[1], match[2]);
    const tableNodeId = `db:table:${tableQualifiedName}`;
    const functionQualifiedName = qualifyName(match[3], match[4]);
    edges.push(edge(tableNodeId, 'function', functionQualifiedName, 'calls'));
  }

  return Object.freeze(edges);
}
