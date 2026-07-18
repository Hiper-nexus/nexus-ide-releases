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
 * Parse a unified git diff into hunks (file + @@ blocks).
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split(/\r?\n/);
  let file = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = m?.[2] ?? m?.[1] ?? '';
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') file = p.replace(/^b\//, '');
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
