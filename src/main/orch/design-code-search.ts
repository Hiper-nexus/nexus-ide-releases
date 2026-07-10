import fs from 'node:fs';
import path from 'node:path';
import type { BrowserDesignElementContext } from '../../shared/browser-design';

/**
 * L2 DOM→code mapping (VISUAL-EDIT-001, Fase 1): heuristic, dependency-free
 * workspace search that turns a design-mode selection into top-N candidate
 * `file:line` anchors with a score. Deterministic and bounded — it feeds the
 * agent context (padrão impeccable: ambiguity is the agent's problem), never
 * a write-back. Pure Node fs so it behaves identically on macOS/Win/Linux.
 */

export interface DesignSearchQuery {
  /** Component names, nearest owner first (from L1 hints). */
  componentNames?: string[];
  classes?: string[];
  id?: string;
  /** Short visible-text snippet (already redacted upstream). */
  text?: string;
}

export interface DesignCodeCandidate {
  /** Path relative to the search root (platform separators). */
  file: string;
  /** 1-based line of the strongest anchor found in the file. */
  line: number;
  score: number;
  /** Human-readable reasons, e.g. "component:SaveButton", "class:btn". */
  matched: string[];
}

export interface DesignSearchOptions {
  maxResults?: number;
  maxFiles?: number;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vite',
  '.cache',
  '.turbo',
  '.output',
  '.claude',
  '.codex',
  '.nexus',
  '.agents',
  '.cursor',
  'vendor',
]);

const CODE_EXTENSIONS = new Set([
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.css',
  '.scss',
]);

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 4_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_COMPONENT_NAMES = 3;
const MAX_CLASSES = 8;
const MIN_CLASS_CHARS = 3;
const MIN_TEXT_CHARS = 4;
const MAX_TEXT_CHARS = 48;

const WEIGHT_DEFINITION = 60;
const WEIGHT_ID = 40;
const WEIGHT_FILENAME = 30;
const WEIGHT_TEXT = 25;
const WEIGHT_USAGE = 15;
const WEIGHT_CLASS = 12;

/** Derive the L2 query from a stored selection (L0 + optional L1). */
export function queryFromSelection(
  selection: BrowserDesignElementContext,
): DesignSearchQuery {
  const query: DesignSearchQuery = {};
  const hints = selection.frameworkHints;
  if (hints) {
    const names = [
      ...(hints.componentName ? [hints.componentName] : []),
      ...hints.ownerChain,
    ];
    const unique = [...new Set(names.filter((name) => name.length > 1))].slice(
      0,
      MAX_COMPONENT_NAMES,
    );
    if (unique.length) query.componentNames = unique;
  }
  const classes = selection.classes
    .filter((cls) => cls.length >= MIN_CLASS_CHARS)
    .slice(0, MAX_CLASSES);
  if (classes.length) query.classes = classes;
  if (selection.id) query.id = selection.id;
  const text = selection.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS).trim();
  if (text.length >= MIN_TEXT_CHARS && !text.startsWith('[sensitive')) {
    query.text = text;
  }
  return query;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Signal {
  weight: number;
  label: string;
  regex: RegExp;
}

function buildSignals(query: DesignSearchQuery): Signal[] {
  const signals: Signal[] = [];
  for (const name of query.componentNames ?? []) {
    const escaped = escapeRegex(name);
    signals.push({
      weight: WEIGHT_DEFINITION,
      label: `component:${name}`,
      regex: new RegExp(`\\b(?:function|const|class|let|var)\\s+${escaped}\\b`),
    });
    signals.push({
      weight: WEIGHT_USAGE,
      label: `usage:${name}`,
      regex: new RegExp(`<${escaped}[\\s/>]`),
    });
  }
  if (query.id) {
    const escaped = escapeRegex(query.id);
    signals.push({
      weight: WEIGHT_ID,
      label: `id:${query.id}`,
      regex: new RegExp(`(?:id=["']${escaped}["']|#${escaped}(?![\\w-]))`),
    });
  }
  for (const cls of query.classes ?? []) {
    const escaped = escapeRegex(cls);
    signals.push({
      weight: WEIGHT_CLASS,
      label: `class:${cls}`,
      regex: new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`),
    });
  }
  if (query.text) {
    signals.push({
      weight: WEIGHT_TEXT,
      label: `text:"${query.text}"`,
      regex: new RegExp(escapeRegex(query.text), 'i'),
    });
  }
  return signals;
}

async function collectFiles(rootDir: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [rootDir];
  while (queue.length && files.length < maxFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      // Symlinks are never followed: they could escape the workspace.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
        const child = path.join(dir, entry.name);
        try {
          await fs.promises.lstat(path.join(child, '.git'));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        queue.push(child);
      } else if (entry.isFile()) {
        if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }
  return files;
}

interface FileScore {
  score: number;
  matched: string[];
  anchorLine: number;
  anchorWeight: number;
}

function scoreContent(content: string, signals: Signal[]): FileScore | null {
  const lines = content.split('\n');
  let score = 0;
  const matched: string[] = [];
  let anchorLine = 1;
  let anchorWeight = 0;
  for (const signal of signals) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!signal.regex.test(lines[index])) continue;
      score += signal.weight;
      matched.push(signal.label);
      if (signal.weight > anchorWeight) {
        anchorWeight = signal.weight;
        anchorLine = index + 1;
      }
      break; // Count each signal once per file.
    }
  }
  return score > 0 ? { score, matched, anchorLine, anchorWeight } : null;
}

export async function searchWorkspaceForSelection(
  rootDir: string,
  query: DesignSearchQuery,
  options: DesignSearchOptions = {},
): Promise<DesignCodeCandidate[]> {
  const signals = buildSignals(query);
  if (!signals.length) return [];
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const componentNames = (query.componentNames ?? []).map((name) =>
    name.toLowerCase(),
  );

  const files = await collectFiles(rootDir, maxFiles);
  const candidates: DesignCodeCandidate[] = [];
  for (const filePath of files) {
    let content: string;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const result = scoreContent(content, signals);
    if (!result) continue;
    let { score } = result;
    const { matched } = result;
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const nameMatch = componentNames.find((name) => name === base);
    if (nameMatch) {
      score += WEIGHT_FILENAME;
      matched.push(`filename:${nameMatch}`);
    }
    candidates.push({
      file: path.relative(rootDir, filePath),
      line: result.anchorLine,
      score,
      matched,
    });
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxResults);
}
