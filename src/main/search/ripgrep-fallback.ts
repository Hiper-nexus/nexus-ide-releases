import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SearchHit, SearchQuery } from '../../shared/search-mixer-types';
import { redactCommandLine } from '../terminal/command-redaction';

/**
 * Local ripgrep (or grep) fallback for SearchMixer file content hits.
 * Fail-closed: no projectRoot → empty; binary path fixed; timeout.
 */

const MAX_HITS = 30;
const TIMEOUT_MS = 2_000;
const MAX_LINE = 400;

export interface RipgrepFallbackOptions {
  readonly rgPath?: string;
  readonly timeoutMs?: number;
}

function redactSnippet(text: string): string {
  const r = redactCommandLine(text, { denylist: [] });
  return r.command.length > MAX_LINE
    ? `${r.command.slice(0, MAX_LINE)}…`
    : r.command;
}

export async function searchWithRipgrep(
  query: SearchQuery,
  options: RipgrepFallbackOptions = {},
): Promise<readonly SearchHit[]> {
  const needle = query.text.trim();
  const root = query.projectRoot;
  if (!needle || !root) return [];
  if (root.includes('\0') || !path.isAbsolute(root)) return [];

  const rg = options.rgPath ?? 'rg';
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  return new Promise((resolve) => {
    const args = [
      '--json',
      '--max-count',
      '5',
      '--max-filesize',
      '512K',
      '-g',
      '!node_modules',
      '-g',
      '!.git',
      '-g',
      '!out',
      '-g',
      '!.vite',
      '--',
      needle,
      root,
    ];
    const child = spawn(rg, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH },
    });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) child.kill('SIGTERM');
    });

    child.on('error', () => {
      clearTimeout(timer);
      // Fallback to grep if rg missing.
      void searchWithGrep(needle, root, timeoutMs).then(resolve);
    });

    child.on('close', () => {
      clearTimeout(timer);
      const hits: SearchHit[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim() || hits.length >= MAX_HITS) break;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: {
              path?: { text?: string };
              lines?: { text?: string };
              line_number?: number;
            };
          };
          if (row.type !== 'match' || !row.data?.path?.text) continue;
          const filePath = row.data.path.text;
          const snippet = redactSnippet(row.data.lines?.text ?? '');
          hits.push({
            id: `rg:${filePath}:${row.data.line_number ?? 0}`,
            source: 'files',
            title: path.basename(filePath),
            subtitle: filePath,
            score: 0.55,
            snippet,
            path: filePath,
            meta: { line: row.data.line_number ?? 0, via: 'ripgrep' },
          });
        } catch {
          // skip bad lines
        }
      }
      resolve(hits);
    });
  });
}

async function searchWithGrep(
  needle: string,
  root: string,
  timeoutMs: number,
): Promise<readonly SearchHit[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'grep',
      ['-R', '-n', '-I', '--exclude-dir=node_modules', '--exclude-dir=.git', '-m', '30', '--', needle, root],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const hits: SearchHit[] = [];
      for (const line of stdout.split('\n')) {
        if (!line || hits.length >= MAX_HITS) break;
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        hits.push({
          id: `grep:${m[1]}:${m[2]}`,
          source: 'files',
          title: path.basename(m[1]),
          subtitle: m[1],
          score: 0.45,
          snippet: redactSnippet(m[3]),
          path: m[1],
          meta: { line: Number(m[2]), via: 'grep' },
        });
      }
      resolve(hits);
    });
  });
}

export function createRipgrepSearchProvider(
  options: RipgrepFallbackOptions = {},
): {
  readonly source: 'files';
  search(
    query: SearchQuery,
    signal: AbortSignal,
  ): Promise<readonly SearchHit[]>;
} {
  return {
    source: 'files',
    async search(query, signal) {
      if (signal.aborted) return [];
      const hits = await searchWithRipgrep(query, options);
      if (signal.aborted) return [];
      return hits;
    },
  };
}
