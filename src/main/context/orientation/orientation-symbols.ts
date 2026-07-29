import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { readWorkspaceTextFile } from '../../orch/workspace-file';
import type {
  OrientationLimits,
  OrientationSymbolHub,
  OrientationSymbolSummary,
} from './orientation-types';
import type { OrientationWalkResult } from './orientation-walker';
import {
  sortOrientationItems,
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';

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

interface SymbolAccumulator {
  readonly symbols: Set<string>;
  readonly hubs: Map<string, HubAccumulator>;
  readonly coverage: Set<string>;
  bytesScanned: number;
  filesScanned: number;
}

export interface OrientationSymbolFileFact {
  readonly relativePath: string;
  readonly language: string | null;
  readonly size: number;
  readonly declarations: readonly string[];
}

function emptySymbolAccumulator(): SymbolAccumulator {
  return {
    symbols: new Set(),
    hubs: new Map(),
    coverage: new Set(),
    bytesScanned: 0,
    filesScanned: 0,
  };
}

function accumulateSymbolFact(
  accumulator: SymbolAccumulator,
  fact: OrientationSymbolFileFact,
  limits: OrientationLimits,
): boolean {
  if (fact.size > limits.maxFileBytes) return true;
  accumulator.bytesScanned += fact.size;
  if (accumulator.bytesScanned > limits.maxTotalBytes) return false;
  accumulator.filesScanned += 1;
  if (fact.language) accumulator.coverage.add(fact.language);
  const baseName = path.posix.basename(
    fact.relativePath,
    path.posix.extname(fact.relativePath),
  );
  if (baseName && !NOISE_NAMES.has(baseName)) {
    accumulator.symbols.add(baseName);
    bumpHub(accumulator.hubs, baseName, fact.relativePath, 2);
  }
  for (const name of fact.declarations) {
    accumulator.symbols.add(name);
    bumpHub(accumulator.hubs, name, fact.relativePath, 1);
  }
  return true;
}

function hubFromEntry(
  entry: readonly [string, HubAccumulator],
): OrientationSymbolHub {
  const [name, accumulator] = entry;
  return Object.freeze({
    name,
    score: accumulator.score,
    samplePaths: Object.freeze(
      [...accumulator.paths]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 3),
    ),
  });
}

function finishSymbolSummary(
  accumulator: SymbolAccumulator,
  limits: OrientationLimits,
): OrientationSymbolSummary {
  const hubList = [...accumulator.hubs.entries()]
    .map(hubFromEntry)
    .sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    )
    .slice(0, limits.maxHubs);
  return Object.freeze({
    filesScanned: accumulator.filesScanned,
    symbolCount: accumulator.symbols.size,
    hubs: Object.freeze(hubList),
    coverage: Object.freeze(
      [...accumulator.coverage].sort((left, right) =>
        left.localeCompare(right)),
    ),
    symbols: accumulator.symbols,
  });
}

async function finishSymbolSummaryAsync(
  accumulator: SymbolAccumulator,
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<OrientationSymbolSummary> {
  const hubs: OrientationSymbolHub[] = [];
  let processed = 0;
  for (const entry of accumulator.hubs.entries()) {
    hubs.push(hubFromEntry(entry));
    processed += 1;
    if (processed % 512 === 0) await yieldOrientationWork(signal);
  }
  const sortedHubs = await sortOrientationItems(
    hubs,
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name),
    signal,
  );
  return Object.freeze({
    filesScanned: accumulator.filesScanned,
    symbolCount: accumulator.symbols.size,
    hubs: Object.freeze(sortedHubs.slice(0, limits.maxHubs)),
    coverage: Object.freeze(
      [...accumulator.coverage].sort((left, right) =>
        left.localeCompare(right)),
    ),
    symbols: accumulator.symbols,
  });
}

export function extractOrientationDeclarations(
  content: string,
): readonly string[] {
  const declarations: string[] = [];
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (
        !name ||
        NOISE_NAMES.has(name) ||
        name.length < 2 ||
        name.length > 128
      ) {
        continue;
      }
      declarations.push(name);
    }
  }
  return Object.freeze(declarations);
}

export function buildOrientationSymbolsFromFacts(
  facts: readonly OrientationSymbolFileFact[],
  limits: OrientationLimits,
): OrientationSymbolSummary {
  const accumulator = emptySymbolAccumulator();
  for (const fact of facts) {
    if (!accumulateSymbolFact(accumulator, fact, limits)) break;
  }
  return finishSymbolSummary(accumulator, limits);
}

export async function buildOrientationSymbolsFromFactsAsync(
  facts: readonly OrientationSymbolFileFact[],
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<OrientationSymbolSummary> {
  throwIfOrientationAborted(signal);
  const accumulator = emptySymbolAccumulator();
  for (let factIndex = 0; factIndex < facts.length; factIndex += 1) {
    if (!accumulateSymbolFact(accumulator, facts[factIndex], limits)) break;
    if (factIndex > 0 && factIndex % 256 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return finishSymbolSummaryAsync(accumulator, limits, signal);
}

export function buildOrientationSymbols(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  limits: OrientationLimits,
): OrientationSymbolSummary {
  const facts: OrientationSymbolFileFact[] = [];
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
    facts.push(Object.freeze({
      relativePath: file.relativePath,
      language: file.language,
      size,
      declarations: extractOrientationDeclarations(content),
    }));
  }
  return buildOrientationSymbolsFromFacts(facts, limits);
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
