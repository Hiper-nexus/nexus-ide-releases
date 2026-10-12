import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Caminhada limitada do workspace por nome de arquivo — o motor do
 * `nexus_file_search` (MCP) e da busca de arquivos da paleta (files:search).
 * Pula dotfiles e node_modules; para em orçamento de resultados, arquivos,
 * diretórios ou tempo e devolve caminhos relativos em estilo posix.
 */

const SEARCH_YIELD_EVERY_ENTRIES = 128;

export type SearchStopReason =
  | 'maxResults'
  | 'maxFiles'
  | 'maxDirectories'
  | 'timeout';

export interface SearchBudgets {
  maxResults: number;
  maxFiles: number;
  maxDirectories: number;
  timeoutMs: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readDirectoryUntil(
  directory: string,
  deadline: number,
): Promise<fs.Dirent[] | null> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(resolve, Math.max(1, Math.ceil(remainingMs)), null);
    timeout.unref?.();
  });
  const entriesPromise: Promise<fs.Dirent[]> = fs.promises.readdir(directory, {
    withFileTypes: true,
  });
  try {
    return await Promise.race([entriesPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function searchWorkspaceFiles(
  root: string,
  pattern: string,
  budgets: SearchBudgets,
  /** Padrão: glob de `pattern`. A paleta passa um filtro próprio (sem caixa). */
  matchesPattern?: (relativePath: string) => boolean,
): Promise<{
  pattern: string;
  count: number;
  files: string[];
  truncated: boolean;
  stoppedBy: SearchStopReason | null;
  scanned: { files: number; directories: number; elapsedMs: number };
  limits: SearchBudgets;
}> {
  const startedAt = performance.now();
  const deadline = startedAt + budgets.timeoutMs;
  const results: string[] = [];
  // F-1325: `./` iniciais (repetidos) são cosméticos — sem a normalização o
  // `.` virava segmento literal do prefixo e nada casava. `../` continua
  // intocado e recusado pela contenção do prefixo.
  const normalizedPattern = pattern.replace(/^(?:\.\/)+/, '');
  const matches = matchesPattern ?? createGlobMatcher(normalizedPattern);
  // F-1231: só o glob tem prefixo literal; o filtro próprio da paleta varre tudo.
  const prefix = matchesPattern ? [] : literalDirectoryPrefix(normalizedPattern);
  const pendingDirectories = [root];
  const pendingDepths = [0];
  let nextDirectory = 0;
  let scheduledDirectories = 1;
  let scannedDirectories = 0;
  let scannedFiles = 0;
  let visitedEntries = 0;
  let stoppedBy: SearchStopReason | null = null;

  const hasTimedOut = () => performance.now() >= deadline;

  // Garante que até buscas pequenas nunca executem toda a caminhada no turno
  // do chamador do processo principal.
  await yieldToEventLoop();

  search: while (nextDirectory < pendingDirectories.length) {
    if (hasTimedOut()) {
      stoppedBy = 'timeout';
      break;
    }
    if (results.length >= budgets.maxResults) {
      stoppedBy = 'maxResults';
      break;
    }
    if (scannedDirectories >= budgets.maxDirectories) {
      stoppedBy = 'maxDirectories';
      break;
    }

    const directory = pendingDirectories[nextDirectory];
    const depth = pendingDepths[nextDirectory];
    nextDirectory += 1;
    scannedDirectories += 1;
    let entries: fs.Dirent[];
    try {
      const read = await readDirectoryUntil(directory, deadline);
      if (read === null) {
        stoppedBy = 'timeout';
        break;
      }
      entries = read;
    } catch {
      continue;
    }
    if (hasTimedOut()) {
      stoppedBy = 'timeout';
      break;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries % SEARCH_YIELD_EVERY_ENTRIES === 0) {
        await yieldToEventLoop();
      }
      if (hasTimedOut()) {
        stoppedBy = 'timeout';
        break search;
      }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      // F-1231: acima do fim do prefixo literal só desce no diretório (real,
      // nunca symlink) de nome exato; nada fora dele pode casar com o glob.
      if (depth < prefix.length && (!entry.isDirectory() || entry.name !== prefix[depth])) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (scheduledDirectories >= budgets.maxDirectories) {
          stoppedBy = 'maxDirectories';
          break search;
        }
        pendingDirectories.push(fullPath);
        pendingDepths.push(depth + 1);
        scheduledDirectories += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      if (scannedFiles >= budgets.maxFiles) {
        stoppedBy = 'maxFiles';
        break search;
      }

      scannedFiles += 1;
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (matches(relativePath)) results.push(relativePath);
      if (results.length >= budgets.maxResults) {
        stoppedBy = 'maxResults';
        break search;
      }
      if (scannedFiles >= budgets.maxFiles) {
        stoppedBy = 'maxFiles';
        break search;
      }
    }
  }

  return {
    pattern,
    count: results.length,
    files: results,
    truncated: stoppedBy !== null,
    stoppedBy,
    scanned: {
      files: scannedFiles,
      directories: scannedDirectories,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    },
    limits: budgets,
  };
}

/**
 * F-1231: diretórios literais do começo do glob (`src/main/updater*.ts` →
 * `src`, `main`). O último segmento é o nome do arquivo e nunca entra; o
 * prefixo para no primeiro segmento com curinga. Glob sem `/` casa também
 * pelo basename, em qualquer profundidade: prefixo vazio.
 */
export function literalDirectoryPrefix(pattern: string): string[] {
  const segments = pattern.split('/');
  const prefix: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}]/.test(segment)) break;
    prefix.push(segment);
  }
  return prefix;
}

/**
 * Simple glob matcher for common patterns.
 * Supports **, *, and ? wildcards.
 */
function createGlobMatcher(pattern: string): (filePath: string) => boolean {
  const regex = globToRegex(pattern);
  const matchesBasename = !pattern.includes('/');
  return (filePath) =>
    regex.test(filePath) ||
    (matchesBasename && regex.test(path.basename(filePath)));
}

function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    // F-1251: `/**/` no meio do glob casa zero ou mais diretórios (a/**/b casa a/b).
    // `**/` no início também casa na raiz (**/b casa b).
    if (pattern.slice(i, i + 4) === '/**/') {
      regexStr += '/(?:.+/)?';
      i += 4;
    } else if (i === 0 && pattern.slice(i, i + 3) === '**/') {
      regexStr += '(?:.+/)?';
      i += 3;
    } else if (pattern.slice(i) === '/**') {
      regexStr += '/.*';
      i += 3;
    } else if (pattern.slice(i, i + 2) === '**') {
      regexStr += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      regexStr += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(pattern[i])) {
      regexStr += '\\' + pattern[i];
      i += 1;
    } else {
      regexStr += pattern[i];
      i += 1;
    }
  }
  return new RegExp('^' + regexStr + '$');
}
