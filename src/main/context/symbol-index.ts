import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { readWorkspaceTextFile } from '../orch/workspace-file';

const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 16;
const SKIP_DIRECTORIES = new Set([
  '.git', '.nexus', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv',
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.kt', '.kts', '.cs', '.c', '.h', '.cpp', '.hpp', '.rb', '.php',
  '.swift', '.scala', '.sql', '.graphql', '.gql',
]);
const DECLARATION_PATTERNS = [
  /\b(?:class|interface|type|enum|function|namespace|module)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[:=])/g,
  /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
  /\b(?:struct|trait|fn)\s+([A-Za-z_]\w*)/g,
  /\bCREATE\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_]\w*)/gi,
  /\b(?:type|input|interface|union|enum|scalar|directive)\s+([A-Za-z_]\w*)/g,
] as const;

export interface SymbolIndexResult {
  readonly symbols: ReadonlySet<string>;
  readonly filesScanned: number;
  readonly bytesScanned: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function buildProjectSymbolIndex(
  scope: ProjectExecutionScope,
): SymbolIndexResult {
  const root = fs.realpathSync(scope.rootRealPath);
  if (root !== scope.rootRealPath) throw new Error('project root identity changed');
  const relativeFiles: string[] = [];

  function walk(relative: string, depth: number): void {
    if (depth > MAX_DEPTH) throw new Error('source tree exceeds symbol index depth');
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe symbol index directory: ${relative || '.'}`);
    }
    const real = fs.realpathSync(absolute);
    if (!isInside(root, real)) throw new Error('symbol index directory escapes project');
    const entries = fs.readdirSync(real, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      relativeFiles.push(child);
      if (relativeFiles.length > MAX_FILES) throw new Error('symbol index file limit exceeded');
    }
  }

  walk('', 0);
  const symbols = new Set<string>();
  let bytesScanned = 0;
  for (const relative of relativeFiles) {
    const read = readWorkspaceTextFile(scope, relative);
    if (read.size > MAX_FILE_BYTES) continue;
    bytesScanned += read.size;
    if (bytesScanned > MAX_TOTAL_BYTES) throw new Error('symbol index byte limit exceeded');
    symbols.add(path.basename(relative, path.extname(relative)));
    for (const pattern of DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of read.content.matchAll(pattern)) {
        if (match[1]) symbols.add(match[1]);
      }
    }
  }
  return Object.freeze({
    symbols,
    filesScanned: relativeFiles.length,
    bytesScanned,
  });
}
