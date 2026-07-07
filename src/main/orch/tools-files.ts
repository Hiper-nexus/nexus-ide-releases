import type { McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import fs from 'node:fs';
import path from 'node:path';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';

/**
 * File-system MCP tools for Jarvis agent.
 * Operates within the workspace boundary — no absolute paths outside cwd
 * unless explicitly allowed by guardrails.
 */

function resolveWorkspacePath(relativePath: string): string {
  const cwd = activeWorkspaceOrNull();
  if (!cwd) throw new Error('no workspace open');
  // Normalize and prevent directory traversal
  const resolved = path.resolve(cwd, relativePath);
  if (!resolved.startsWith(cwd)) {
    throw new Error(`path escapes workspace: ${relativePath}`);
  }
  return resolved;
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
  handler: async (args) => {
    const relativePath = requireStr(args, 'path');
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const absolutePath = resolveWorkspacePath(relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`file not found: ${relativePath}`);
    }
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      throw new Error(`path is a directory: ${relativePath}`);
    }
    const content = fs.readFileSync(absolutePath, encoding as BufferEncoding);
    return {
      path: relativePath,
      size: stat.size,
      content,
    };
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
  handler: async (args) => {
    const relativePath = requireStr(args, 'path');
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const absolutePath = resolveWorkspacePath(relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`file not found: ${relativePath}`);
    }
    const raw = fs.readFileSync(absolutePath, encoding as BufferEncoding);
    const offset = typeof args.offset === 'number' ? args.offset : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    if (offset === undefined && limit === undefined) {
      return { path: relativePath, content: raw };
    }
    const lines = raw.split('\n');
    const start = Math.max(1, offset ?? 1) - 1;
    const end = limit !== undefined ? start + limit : lines.length;
    const sliced = lines.slice(start, end).join('\n');
    return {
      path: relativePath,
      offset: start + 1,
      limit: sliced.split('\n').length,
      content: sliced,
    };
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
  handler: async (args) => {
    const relativePath = requireStr(args, 'path');
    const content = requireStr(args, 'content');
    const encoding = str(args, 'encoding') ?? 'utf-8';
    const absolutePath = resolveWorkspacePath(relativePath);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const existed = fs.existsSync(absolutePath);
    fs.writeFileSync(absolutePath, content, encoding as BufferEncoding);
    return {
      path: relativePath,
      existed,
      written: Buffer.byteLength(content, encoding as BufferEncoding),
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
        description: 'Maximum number of results (default: 100)',
      },
    },
    required: ['pattern'],
  },
  handler: async (args) => {
    const pattern = requireStr(args, 'pattern');
    const cwd = activeWorkspaceOrNull();
    if (!cwd) throw new Error('no workspace open');
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 100;

    // Simple glob implementation using fs.readdirSync recursively
    const results: string[] = [];
    const searchDir = (dir: string, base: string) => {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(base, fullPath);
        if (entry.isDirectory()) {
          searchDir(fullPath, base);
        } else if (matchGlob(relPath, pattern)) {
          results.push(relPath);
        }
      }
    };
    searchDir(cwd, cwd);
    return { pattern, count: results.length, files: results };
  },
};

/**
 * Simple glob matcher for common patterns.
 * Supports **, *, and ? wildcards.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(filePath);
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
  return [fileOpen, fileRead, fileWrite, fileSearch];
}