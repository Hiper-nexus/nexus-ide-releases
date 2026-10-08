import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SearchHit, SearchQuery } from '../../shared/search-mixer-types';
import { redactCommandLine } from '../../shared/secret-redaction';

/**
 * Local ripgrep (or grep) fallback for SearchMixer file content hits.
 * Fail-closed: no projectRoot → empty; binary path fixed; timeout.
 */

const MAX_HITS = 30;
const TIMEOUT_MS = 2_000;
const MAX_LINE = 400;
const MAX_OUTPUT_CHARS = 2_000_000;

export interface RipgrepFallbackOptions {
  readonly rgPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Canonical project roots this provider may search. Missing = deny. */
  readonly allowedRoots?: readonly string[];
}

function authorizedProjectRoot(
  requestedRoot: string,
  allowedRoots: readonly string[] | undefined,
): string | null {
  if (
    !allowedRoots?.length ||
    requestedRoot.includes('\0') ||
    !path.isAbsolute(requestedRoot)
  ) {
    return null;
  }
  try {
    const requested = fs.realpathSync(requestedRoot);
    const isAllowed = allowedRoots.some((allowedRoot) => {
      const allowed = fs.realpathSync(allowedRoot);
      const relative = path.relative(allowed, requested);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    return isAllowed ? requested : null;
  } catch {
    return null;
  }
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
  const requestedRoot = query.projectRoot;
  if (!needle || !requestedRoot) return [];
  const root = authorizedProjectRoot(requestedRoot, options.allowedRoots);
  if (!root) return [];

  const rg = options.rgPath ?? 'rg';
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) return [];

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
      '!.nexus-memory/**',
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
    let settled = false;
    let fallbackStarted = false;
    const finish = (hits: readonly SearchHit[]) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(hits);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish([]);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
        child.kill('SIGTERM');
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      if (settled || signal?.aborted) return;
      // Fallback to grep if rg missing.
      fallbackStarted = true;
      void searchWithGrep(needle, root, timeoutMs, signal).then(finish);
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (settled || fallbackStarted) return;
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
      finish(hits);
    });
  });
}

async function searchWithGrep(
  needle: string,
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<readonly SearchHit[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'grep',
      [
        '-R',
        '-n',
        '-I',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=.nexus-memory',
        '-m',
        '30',
        '--',
        needle,
        root,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    let settled = false;
    const finish = (hits: readonly SearchHit[]) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(hits);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish([]);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
        child.kill('SIGTERM');
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish([]);
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
      finish(hits);
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
      const hits = await searchWithRipgrep(query, { ...options, signal });
      if (signal.aborted) return [];
      return hits;
    },
  };
}
