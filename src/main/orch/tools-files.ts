import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { requireStr, str } from './tool-util';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import {
  openWorkspaceFileForRead,
  writeWorkspaceTextFile,
} from './workspace-file';
import { resolveCwdForScope } from './workspace-path';
import { assertAgentReadablePath } from './agent-path-policy';

/**
 * File-system MCP tools for Jarvis agent.
 * Operates within the workspace boundary — no absolute paths outside cwd
 * unless explicitly allowed by guardrails.
*/

const MAX_FULL_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_LINES = 10_000;
const DEFAULT_SEARCH_MAX_RESULTS = 100;
const HARD_SEARCH_MAX_RESULTS = 1_000;
const DEFAULT_SEARCH_MAX_FILES = 20_000;
const HARD_SEARCH_MAX_FILES = 100_000;
const DEFAULT_SEARCH_MAX_DIRECTORIES = 2_000;
const HARD_SEARCH_MAX_DIRECTORIES = 20_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 1_500;
const HARD_SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_YIELD_EVERY_ENTRIES = 128;
const MAX_SEARCH_PATTERN_CHARS = 512;

type SearchStopReason =
  | 'maxResults'
  | 'maxFiles'
  | 'maxDirectories'
  | 'timeout';

interface SearchBudgets {
  maxResults: number;
  maxFiles: number;
  maxDirectories: number;
  timeoutMs: number;
}

function assertFullReadSize(stat: fs.Stats): void {
  if (stat.size > MAX_FULL_FILE_BYTES) {
    throw new Error(
      `file exceeds ${MAX_FULL_FILE_BYTES} bytes; use offset + limit`,
    );
  }
}

function readLineRange(
  fd: number,
  encoding: BufferEncoding,
  start: number,
  limit: number,
): string[] {
  const decoder = new StringDecoder(encoding);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const selected: string[] = [];
  let lineNumber = 1;
  let current = '';
  let selectedChars = 0;

  const consume = (chunk: string): boolean => {
    let cursor = 0;
    while (cursor <= chunk.length) {
      const newline = chunk.indexOf('\n', cursor);
      const end = newline === -1 ? chunk.length : newline;
      if (lineNumber >= start && selected.length < limit) {
        const part = chunk.slice(cursor, end);
        selectedChars += part.length;
        if (selectedChars > MAX_FULL_FILE_BYTES) {
          throw new Error(`requested line range exceeds ${MAX_FULL_FILE_BYTES} characters`);
        }
        current += part;
      }
      if (newline === -1) break;
      if (lineNumber >= start && selected.length < limit) {
        selected.push(current.endsWith('\r') ? current.slice(0, -1) : current);
        current = '';
        if (selected.length >= limit) return true;
      }
      lineNumber += 1;
      cursor = newline + 1;
    }
    return false;
  };

  let position = 0;
  while (selected.length < limit) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (consume(decoder.write(buffer.subarray(0, bytesRead)))) return selected;
  }
  consume(decoder.end());
  if (lineNumber >= start && selected.length < limit && current) {
    selected.push(current.endsWith('\r') ? current.slice(0, -1) : current);
  }
  return selected;
}

const fileOpen: McpToolDef = {
  name: 'nexus_file_open',
  description:
    'Open a file in the editor by its workspace-relative path. ' +
    'Returns the file content as text. Use this to read source files ' +
    'before editing them.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    assertAgentReadablePath(relativePath);
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const handle = openWorkspaceFileForRead(executionScopeFor(ctx), relativePath);
    try {
      assertFullReadSize(handle.stat);
      const content = fs.readFileSync(handle.fd, {
        encoding: encoding as BufferEncoding,
      });
      return {
        path: relativePath,
        size: handle.stat.size,
        content,
      };
    } finally {
      handle.close();
    }
  },
};

const fileClose: McpToolDef = {
  name: 'nexus_file_close',
  description:
    'Close a file in the editor by its workspace-relative path. ' +
    'This is a safe no-op for headless MCP callers and exists so agents can ' +
    'complete open/read/edit workflows consistently.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    assertAgentReadablePath(relativePath);
    const handle = openWorkspaceFileForRead(executionScopeFor(ctx), relativePath);
    handle.close();
    return { path: relativePath, closed: true };
  },
};

const fileRead: McpToolDef = {
  name: 'nexus_file_read',
  description:
    'Read a file from the workspace. Returns the full content as text. ' +
    'Optionally specify a line range (offset/limit) for large files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      offset: {
        type: 'number',
        description: '1-based starting line number (default: 1)',
      },
      limit: {
        type: 'number',
        description: 'Max number of lines to return (default: all)',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    assertAgentReadablePath(relativePath);
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const handle = openWorkspaceFileForRead(executionScopeFor(ctx), relativePath);
    try {
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      if (offset === undefined && limit === undefined) {
        assertFullReadSize(handle.stat);
        const raw = fs.readFileSync(handle.fd, {
          encoding: encoding as BufferEncoding,
        });
        return { path: relativePath, content: raw };
      }
      const start = Math.max(1, Math.trunc(offset ?? 1));
      const boundedLimit = Math.max(
        1,
        Math.min(MAX_RANGE_LINES, Math.trunc(limit ?? MAX_RANGE_LINES)),
      );
      const selected = await readLineRange(
        handle.fd,
        encoding as BufferEncoding,
        start,
        boundedLimit,
      );
      const sliced = selected.join('\n');
      return {
        path: relativePath,
        offset: start,
        limit: selected.length,
        content: sliced,
      };
    } finally {
      handle.close();
    }
  },
};

const fileWrite: McpToolDef = {
  name: 'nexus_file_write',
  description:
    'Write content to a file in the workspace. Creates the file if it ' +
    'does not exist; overwrites it if it does. Creates parent directories ' +
    'as needed. THIS IS DESTRUCTIVE — confirm with the user before ' +
    'overwriting existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
    },
    required: ['path', 'content'],
  },
  handler: async (args, ctx) => {
    const relativePath = requireStr(args, 'path');
    const content = requireStr(args, 'content');
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const result = writeWorkspaceTextFile(
      executionScopeFor(ctx),
      relativePath,
      content,
      encoding as BufferEncoding,
    );
    return {
      path: relativePath,
      ...result,
    };
  },
};

const fileSearch: McpToolDef = {
  name: 'nexus_file_search',
  description:
    'Search for files in the workspace by glob pattern. ' +
    'Returns matching file paths relative to the workspace root. ' +
    'Example patterns: "**/*.ts", "src/**/*.test.ts", "*.json".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results (default: 100, hard max: 1000)',
      },
      maxFiles: {
        type: 'number',
        description: 'Maximum regular files inspected (default: 20000)',
      },
      maxDirectories: {
        type: 'number',
        description: 'Maximum directories traversed (default: 2000)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Wall-clock search budget in milliseconds (default: 1500)',
      },
    },
    required: ['pattern'],
  },
  handler: async (args, ctx) => {
    const pattern = requireStr(args, 'pattern');
    if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
      throw new Error(
        `search pattern exceeds ${MAX_SEARCH_PATTERN_CHARS} characters`,
      );
    }
    const cwd = resolveCwdForScope(executionScopeFor(ctx));
    const budgets: SearchBudgets = {
      maxResults: boundedSearchBudget(
        args.maxResults,
        DEFAULT_SEARCH_MAX_RESULTS,
        HARD_SEARCH_MAX_RESULTS,
      ),
      maxFiles: boundedSearchBudget(
        args.maxFiles,
        DEFAULT_SEARCH_MAX_FILES,
        HARD_SEARCH_MAX_FILES,
      ),
      maxDirectories: boundedSearchBudget(
        args.maxDirectories,
        DEFAULT_SEARCH_MAX_DIRECTORIES,
        HARD_SEARCH_MAX_DIRECTORIES,
      ),
      timeoutMs: boundedSearchBudget(
        args.timeoutMs,
        DEFAULT_SEARCH_TIMEOUT_MS,
        HARD_SEARCH_TIMEOUT_MS,
      ),
    };
    return searchWorkspaceFiles(cwd, pattern, budgets);
  },
};

function boundedSearchBudget(
  value: unknown,
  fallback: number,
  hardMaximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(hardMaximum, Math.trunc(value)));
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

async function searchWorkspaceFiles(
  root: string,
  pattern: string,
  budgets: SearchBudgets,
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
  const pendingDirectories = [root];
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
  const matchesPattern = createGlobMatcher(pattern);

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

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (scheduledDirectories >= budgets.maxDirectories) {
          stoppedBy = 'maxDirectories';
          break search;
        }
        pendingDirectories.push(fullPath);
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
      if (matchesPattern(relativePath)) results.push(relativePath);
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
    if (pattern.slice(i, i + 2) === '**') {
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

export function buildFileTools(): McpToolDef[] {
  return [fileOpen, fileClose, fileRead, fileWrite, fileSearch];
}
