/**
 * Hunk attribution — grok-build xai-hunk-tracker idea, pure TS.
 * Classifies unified-diff hunks as agent | user | external based on
 * mission pane activity timestamps and optional path ownership.
 */
export type HunkSource = 'agent' | 'user' | 'external' | 'mixed';

export interface DiffHunk {
  file: string;
  header: string;
  body: string;
  /** 1-based start line in new file when parseable. */
  newStart?: number;
  newCount?: number;
}

export interface AttributedHunk extends DiffHunk {
  source: HunkSource;
  agentId?: string;
  confidence: number;
}

export interface AgentTouch {
  agentId: string;
  adapterId?: string;
  /** Paths this agent is known to have touched (relative). */
  paths: readonly string[];
  at: number;
}

/**
 * F-1324: o Git escreve caminhos não triviais (UTF-8 fora do ASCII, tab,
 * aspas, barra invertida) entre aspas, com escapes C — octais de byte UTF-8
 * (\303\251 = é) e \", \\, \t, \n… Decodifica um token desses; token sem
 * aspas volta como está.
 */
function decodeGitPathToken(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    return token;
  }
  const inner = token.slice(1, -1);
  let out = '';
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    const percent = bytes
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join('');
    try {
      out += decodeURIComponent(percent);
    } catch {
      out += bytes.map((b) => String.fromCharCode(b)).join('');
    }
    bytes = [];
  };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? '';
    if (ch !== '\\') {
      flushBytes();
      out += ch;
      continue;
    }
    const next = inner[i + 1] ?? '';
    if (/^[0-7]$/.test(next) && /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    flushBytes();
    i += 1;
    switch (next) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      default: out += next;
    }
  }
  flushBytes();
  return out;
}

/** Dois tokens de caminho depois de `diff --git `, entre aspas ou não. */
function splitDiffGitPaths(line: string): [string, string] {
  const rest = line.slice('diff --git '.length);
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    if (rest[i] === ' ') {
      i += 1;
      continue;
    }
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === '\\') j += 2;
        else if (rest[j] === '"') {
          j += 1;
          break;
        } else j += 1;
      }
      tokens.push(rest.slice(i, j));
      i = j;
    } else {
      const j = rest.indexOf(' ', i);
      tokens.push(j === -1 ? rest.slice(i) : rest.slice(i, j));
      i = j === -1 ? rest.length : j;
    }
  }
  return [tokens[0] ?? '', tokens[1] ?? ''];
}

function stripDiffPrefix(decoded: string, prefix: 'a/' | 'b/'): string {
  return decoded.startsWith(prefix) ? decoded.slice(2) : decoded;
}

/**
 * Parse a unified git diff into hunks (file + @@ blocks).
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split(/\r?\n/);
  let file = '';
  let oldFile = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      const [oldToken, newToken] = splitDiffGitPaths(line);
      const oldPath = stripDiffPrefix(decodeGitPathToken(oldToken), 'a/');
      const newPath = stripDiffPrefix(decodeGitPathToken(newToken), 'b/');
      file = newPath || oldPath;
      oldFile = oldPath;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldFile = p === '/dev/null' ? '' : stripDiffPrefix(decodeGitPathToken(p), 'a/');
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      // F-1324: na exclusão o novo nome é /dev/null — vale o nome antigo.
      file = p === '/dev/null' ? oldFile : stripDiffPrefix(decodeGitPathToken(p), 'b/');
      i += 1;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const header = line;
      const range = /\+(\d+)(?:,(\d+))?/.exec(line);
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (
          l.startsWith('diff --git ') ||
          l.startsWith('@@ ') ||
          l.startsWith('diff --cc ')
        ) {
          break;
        }
        body.push(l);
        i += 1;
      }
      hunks.push({
        file,
        header,
        body: body.join('\n'),
        newStart: range ? Number(range[1]) : undefined,
        newCount: range?.[2] ? Number(range[2]) : undefined,
      });
      continue;
    }
    i += 1;
  }
  return hunks;
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Attribute each hunk to the most recent agent that claimed the path,
 * else user if recently touched outside agents, else external.
 */
export function attributeHunks(
  hunks: readonly DiffHunk[],
  agents: readonly AgentTouch[],
  options: { userTouchedPaths?: ReadonlySet<string>; now?: number } = {},
): AttributedHunk[] {
  const sorted = [...agents].sort((a, b) => b.at - a.at);
  return hunks.map((hunk) => {
    const file = normalizePath(hunk.file);
    const match = sorted.find((a) =>
      a.paths.some((p) => {
        const np = normalizePath(p);
        return np === file || file.endsWith(`/${np}`) || np.endsWith(`/${file}`);
      }),
    );
    if (match) {
      return {
        ...hunk,
        source: 'agent' as const,
        agentId: match.agentId,
        confidence: 0.85,
      };
    }
    if (options.userTouchedPaths?.has(file)) {
      return { ...hunk, source: 'user' as const, confidence: 0.7 };
    }
    return { ...hunk, source: 'external' as const, confidence: 0.4 };
  });
}

export function summarizeAttribution(
  attributed: readonly AttributedHunk[],
): Record<HunkSource, number> {
  const out: Record<HunkSource, number> = {
    agent: 0,
    user: 0,
    external: 0,
    mixed: 0,
  };
  for (const h of attributed) out[h.source] += 1;
  return out;
}
