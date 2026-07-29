import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type {
  OrientationDirStat,
  OrientationInventory,
  OrientationLanguageStat,
} from './orientation-types';
import type { OrientationWalkResult, WalkedFile } from './orientation-walker';
import {
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';

const MANIFEST_NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lockb',
  'bun.lock',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'Podfile',
]);

const ENTRYPOINT_CANDIDATES = [
  'src/main/main.ts',
  'src/main.ts',
  'src/index.ts',
  'src/index.js',
  'src/app.ts',
  'src/app.tsx',
  'app/main.ts',
  'cmd/main.go',
  'main.go',
  'main.py',
  'src/main.rs',
  'index.ts',
  'index.js',
];

const SCRIPT_PRIORITY = [
  'typecheck',
  'test',
  'lint',
  'build',
  'dev',
  'start',
  'check',
];
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;

interface PackageSummary {
  readonly name: string | null;
  readonly scripts: Record<string, string>;
  readonly main?: string;
  readonly bin?: unknown;
}

interface InventoryAccumulator {
  readonly langMap: Map<string, { files: number; bytes: number }>;
  readonly dirMap: Map<string, { files: number; bytes: number }>;
  readonly pathSet: Set<string>;
  readonly basenames: Set<string>;
  readonly manifests: string[];
  sourceFileCount: number;
  bytesScanned: number;
}

function topLevelDir(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts[0] : '.';
}

function readPackageJson(
  scope: ProjectExecutionScope,
): PackageSummary | null {
  const absolute = path.join(scope.rootRealPath, 'package.json');
  try {
    const stat = fs.lstatSync(absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_PACKAGE_JSON_BYTES
    ) return null;
    return parsePackageJson(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

function parsePackageJson(content: string): PackageSummary | null {
  try {
    const raw = JSON.parse(content) as {
      name?: unknown;
      scripts?: unknown;
      main?: unknown;
      bin?: unknown;
    };
    const scripts: Record<string, string> = {};
    if (
      raw.scripts &&
      typeof raw.scripts === 'object' &&
      !Array.isArray(raw.scripts)
    ) {
      for (const [key, value] of Object.entries(raw.scripts)) {
        if (
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 512
        ) {
          scripts[key] = value;
        }
      }
    }
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 256) : null,
      scripts,
      main: typeof raw.main === 'string' ? raw.main : undefined,
      bin: raw.bin,
    };
  } catch {
    return null;
  }
}

async function readPackageJsonAsync(
  scope: ProjectExecutionScope,
): Promise<PackageSummary | null> {
  const absolute = path.join(scope.rootRealPath, 'package.json');
  try {
    const stat = await fs.promises.lstat(absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_PACKAGE_JSON_BYTES
    ) {
      return null;
    }
    const real = await fs.promises.realpath(absolute);
    if (path.normalize(real) !== path.normalize(absolute)) return null;
    return parsePackageJson(await fs.promises.readFile(absolute, 'utf8'));
  } catch {
    return null;
  }
}

function pickScripts(all: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of SCRIPT_PRIORITY) {
    if (all[key]) picked[key] = all[key];
  }
  // Keep a few extra named scripts for orientation without dumping everything.
  for (const key of Object.keys(all).sort()) {
    if (picked[key]) continue;
    if (Object.keys(picked).length >= 12) break;
    if (/test|lint|type|build|check|dev|start/i.test(key)) {
      picked[key] = all[key];
    }
  }
  return picked;
}

function detectPackageManagers(basenames: ReadonlySet<string>): string[] {
  const managers: string[] = [];
  if (basenames.has('pnpm-lock.yaml') || basenames.has('pnpm-workspace.yaml')) {
    managers.push('pnpm');
  }
  if (basenames.has('yarn.lock')) managers.push('yarn');
  if (basenames.has('bun.lockb') || basenames.has('bun.lock')) managers.push('bun');
  if (basenames.has('package-lock.json') || basenames.has('package.json')) {
    if (!managers.includes('pnpm') && !managers.includes('yarn') && !managers.includes('bun')) {
      managers.push('npm');
    } else if (basenames.has('package-lock.json')) {
      managers.push('npm');
    }
  }
  if (basenames.has('Cargo.toml')) managers.push('cargo');
  if (basenames.has('go.mod')) managers.push('go');
  if (basenames.has('pyproject.toml') || basenames.has('requirements.txt')) {
    managers.push('python');
  }
  return managers;
}

function emptyAccumulator(): InventoryAccumulator {
  return {
    langMap: new Map(),
    dirMap: new Map(),
    pathSet: new Set(),
    basenames: new Set(),
    manifests: [],
    sourceFileCount: 0,
    bytesScanned: 0,
  };
}

function accumulateFile(
  accumulator: InventoryAccumulator,
  file: WalkedFile,
): void {
  accumulator.bytesScanned += file.size;
  accumulator.pathSet.add(file.relativePath);
  const basename = path.posix.basename(file.relativePath);
  accumulator.basenames.add(basename);
  if (MANIFEST_NAMES.has(basename)) {
    accumulator.manifests.push(file.relativePath);
  }
  if (file.isSource) {
    accumulator.sourceFileCount += 1;
    if (file.language) {
      const current = accumulator.langMap.get(file.language) ?? {
        files: 0,
        bytes: 0,
      };
      current.files += 1;
      current.bytes += file.size;
      accumulator.langMap.set(file.language, current);
    }
  }
  const dir = topLevelDir(file.relativePath);
  const dirStat = accumulator.dirMap.get(dir) ?? { files: 0, bytes: 0 };
  dirStat.files += 1;
  dirStat.bytes += file.size;
  accumulator.dirMap.set(dir, dirStat);
}

function finishInventory(
  walk: OrientationWalkResult,
  accumulator: InventoryAccumulator,
  pkg: PackageSummary | null,
): OrientationInventory {
  const languages: OrientationLanguageStat[] = [
    ...accumulator.langMap.entries(),
  ]
    .map(([id, stat]) =>
      Object.freeze({ id, files: stat.files, bytes: stat.bytes }))
    .sort(
      (left, right) =>
        right.files - left.files || left.id.localeCompare(right.id),
    );
  const topDirs: OrientationDirStat[] = [...accumulator.dirMap.entries()]
    .map(([dirPath, stat]) =>
      Object.freeze({
        path: dirPath,
        files: stat.files,
        bytes: stat.bytes,
      }))
    .sort(
      (left, right) =>
        right.files - left.files || left.path.localeCompare(right.path),
    )
    .slice(0, 12);
  const entrypoints = new Set<string>();
  for (const candidate of ENTRYPOINT_CANDIDATES) {
    if (accumulator.pathSet.has(candidate)) entrypoints.add(candidate);
  }
  if (pkg?.main) {
    const normalized = pkg.main.replace(/^\.\//, '');
    if (accumulator.pathSet.has(normalized)) entrypoints.add(normalized);
  }
  return Object.freeze({
    languages: Object.freeze(languages),
    topDirs: Object.freeze(topDirs),
    entrypoints: Object.freeze(
      [...entrypoints].sort((left, right) => left.localeCompare(right)),
    ),
    // Both walkers feed files in stable path order.
    manifests: Object.freeze([...accumulator.manifests]),
    scripts: Object.freeze(pkg ? pickScripts(pkg.scripts) : {}),
    packageManagers: Object.freeze(
      detectPackageManagers(accumulator.basenames),
    ),
    fileCount: walk.files.length,
    sourceFileCount: accumulator.sourceFileCount,
    bytesScanned: accumulator.bytesScanned,
    projectName: pkg?.name ?? null,
  });
}

export function buildOrientationInventory(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
): OrientationInventory {
  const accumulator = emptyAccumulator();
  for (const file of walk.files) {
    accumulateFile(accumulator, file);
  }
  return finishInventory(walk, accumulator, readPackageJson(scope));
}

export async function buildOrientationInventoryAsync(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
  signal?: AbortSignal,
): Promise<OrientationInventory> {
  throwIfOrientationAborted(signal);
  const accumulator = emptyAccumulator();
  for (let fileIndex = 0; fileIndex < walk.files.length; fileIndex += 1) {
    accumulateFile(accumulator, walk.files[fileIndex]);
    if (fileIndex > 0 && fileIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  const pkg = await readPackageJsonAsync(scope);
  throwIfOrientationAborted(signal);
  return finishInventory(walk, accumulator, pkg);
}
