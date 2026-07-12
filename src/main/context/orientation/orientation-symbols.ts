import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import type {
  OrientationLimits,
  OrientationSymbolHub,
  OrientationSymbolSummary,
} from './orientation-types';
import type { OrientationWalkResult } from './orientation-walker';

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

const NOISE_NAMES = new Set([
  'default',
  'exports',
  'module',
  'require',
  'import',
  'from',
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'async',
  'await',
  'return',
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'Object',
  'Array',
  'Promise',
  'Error',
  'Map',
  'Set',
]);

interface HubAccumulator {
  score: number;
  paths: Set<string>;
}

export function buildOrientationSymbols(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  limits: OrientationLimits,
): OrientationSymbolSummary {
  const symbols = new Set<string>();
  const hubs = new Map<string, HubAccumulator>();
  const coverage = new Set<string>();
  let filesScanned = 0;
  let bytesScanned = 0;

  const sourceFiles = walk.files.filter((file) => file.isSource);
  for (const file of sourceFiles) {
    let content: string;
    let size: number;
    try {
      const read = readWorkspaceTextFile(scope, file.relativePath);
      content = read.content;
      size = read.size;
    } catch {
      continue;
    }
    if (size > limits.maxFileBytes) continue;
    bytesScanned += size;
    if (bytesScanned > limits.maxTotalBytes) break;
    filesScanned += 1;
    if (file.language) coverage.add(file.language);
    const baseName = path.posix.basename(file.relativePath, path.posix.extname(file.relativePath));
    if (baseName && !NOISE_NAMES.has(baseName)) {
      symbols.add(baseName);
      bumpHub(hubs, baseName, file.relativePath, 2);
    }
    for (const pattern of DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const name = match[1];
        if (!name || NOISE_NAMES.has(name) || name.length < 2 || name.length > 128) {
          continue;
        }
        symbols.add(name);
        bumpHub(hubs, name, file.relativePath, 1);
      }
    }
  }

  const hubList: OrientationSymbolHub[] = [...hubs.entries()]
    .map(([name, acc]) =>
      Object.freeze({
        name,
        score: acc.score,
        samplePaths: Object.freeze(
          [...acc.paths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
        ),
      }),
    )
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limits.maxHubs);

  return Object.freeze({
    filesScanned,
    symbolCount: symbols.size,
    hubs: Object.freeze(hubList),
    coverage: Object.freeze([...coverage].sort((a, b) => a.localeCompare(b))),
    symbols,
  });
}

function bumpHub(
  hubs: Map<string, HubAccumulator>,
  name: string,
  filePath: string,
  weight: number,
): void {
  const current = hubs.get(name) ?? { score: 0, paths: new Set<string>() };
  current.score += weight;
  if (current.paths.size < 8) current.paths.add(filePath);
  hubs.set(name, current);
}
