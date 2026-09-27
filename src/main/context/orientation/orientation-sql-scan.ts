/**
 * Single-pass SQL lexer shared by the schema detectors (definitions) and the
 * usage extractor (references), so both read identifiers the same way:
 * unquoted identifiers fold to lower case as PostgreSQL does, quoted ones keep
 * their case. Comments and string literals are skipped; dollar-quoted bodies
 * become one token. Linear in the input — no regex backtracking.
 */
export type SqlToken =
  /** Unquoted word (keyword or identifier), original spelling. */
  | { readonly kind: 'word'; readonly value: string }
  /** "Quoted" identifier, unescaped, case preserved. */
  | { readonly kind: 'qident'; readonly value: string }
  /** 'string' literal or $tag$ body$tag$, unescaped content. */
  | { readonly kind: 'string'; readonly value: string; readonly dollar: boolean }
  | { readonly kind: 'punct'; readonly value: string };

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[\w$\u0080-￿]/;
const DOLLAR_TAG_RE = /^\$([A-Za-z_][\w]{0,62})?\$/;

export function scanSqlTokens(content: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i += 1;
      continue;
    }
    if (ch === '-' && content[i + 1] === '-') {
      const end = content.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      // PostgreSQL block comments nest.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (content[i] === '/' && content[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (content[i] === '*' && content[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = '';
      let segmentStart = i + 1;
      i += 1;
      while (i < n) {
        if (content[i] !== ch) {
          i += 1;
          continue;
        }
        if (content[i + 1] !== ch) break;
        // Doubled quote: an escaped quote inside the literal/identifier.
        value += content.slice(segmentStart, i + 1);
        i += 2;
        segmentStart = i;
      }
      value += content.slice(segmentStart, Math.min(i, n));
      i += 1;
      tokens.push(
        ch === '"'
          ? { kind: 'qident', value }
          : { kind: 'string', value, dollar: false },
      );
      continue;
    }
    if (ch === '$') {
      const tag = DOLLAR_TAG_RE.exec(content.slice(i, i + 65))?.[0];
      if (tag) {
        const bodyStart = i + tag.length;
        const close = content.indexOf(tag, bodyStart);
        const bodyEnd = close < 0 ? n : close;
        tokens.push({ kind: 'string', value: content.slice(bodyStart, bodyEnd), dollar: true });
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && WORD_PART.test(content[i])) i += 1;
      tokens.push({ kind: 'word', value: content.slice(start, i) });
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

export function isSqlWord(token: SqlToken | undefined, ...upper: string[]): boolean {
  return token?.kind === 'word' && upper.includes(token.value.toUpperCase());
}

function identifierValue(token: SqlToken | undefined): string | null {
  if (token?.kind === 'word') return token.value.toLowerCase();
  if (token?.kind === 'qident' && token.value) return token.value;
  return null;
}

export interface SqlQualifiedName {
  /** schema.name, schema defaulting to `public`. */
  readonly qualifiedName: string;
  /** Index of the first token after the name. */
  readonly next: number;
}

/**
 * Read `name` or `schema.name` starting at `index` (either part quoted or
 * not), applying PostgreSQL case folding to unquoted parts.
 */
export function readSqlQualifiedName(
  tokens: readonly SqlToken[],
  index: number,
): SqlQualifiedName | null {
  const first = identifierValue(tokens[index]);
  if (first === null) return null;
  const dot = tokens[index + 1];
  if (dot?.kind === 'punct' && dot.value === '.') {
    const second = identifierValue(tokens[index + 2]);
    if (second !== null) return { qualifiedName: `${first}.${second}`, next: index + 3 };
  }
  return { qualifiedName: `public.${first}`, next: index + 1 };
}

/** Split a token stream on top-level `;` (dollar bodies are already one token). */
export function splitSqlStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

export interface SqlTableRef {
  readonly qualifiedName: string;
  readonly relation: 'reads' | 'writes';
}

// Words that can follow FROM/INTO/UPDATE/JOIN without being a table name
// (ON CONFLICT DO UPDATE SET, FOR UPDATE OF/NOWAIT/SKIP LOCKED, JOIN LATERAL).
const NOT_A_TABLE = new Set(['SET', 'OF', 'NOWAIT', 'SKIP', 'LATERAL', 'SELECT']);

/** Table references after FROM/INTO/UPDATE/JOIN; DELETE FROM/INSERT INTO/UPDATE write. */
export function extractSqlTableRefs(tokens: readonly SqlToken[]): SqlTableRef[] {
  const refs: SqlTableRef[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isSqlWord(token, 'FROM', 'INTO', 'UPDATE', 'JOIN')) continue;
    const keyword = token.value.toUpperCase();
    let nameIndex = index + 1;
    if (isSqlWord(tokens[nameIndex], 'ONLY')) nameIndex += 1;
    const nameToken = tokens[nameIndex];
    if (nameToken?.kind === 'word' && NOT_A_TABLE.has(nameToken.value.toUpperCase())) continue;
    const name = readSqlQualifiedName(tokens, nameIndex);
    if (!name) continue;
    const writes =
      keyword === 'INTO' ||
      keyword === 'UPDATE' ||
      (keyword === 'FROM' && isSqlWord(tokens[index - 1], 'DELETE'));
    refs.push({ qualifiedName: name.qualifiedName, relation: writes ? 'writes' : 'reads' });
  }
  return refs;
}
