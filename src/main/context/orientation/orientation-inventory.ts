import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import type {
  OrientationDirStat,
  OrientationInventory,
  OrientationLanguageStat,
} from './orientation-types';
import type { OrientationWalkResult, WalkedFile } from './orientation-walker';

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

function topLevelDir(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts[0] : '.';
}

function readPackageJson(
  scope: ProjectExecutionScope,
): { name: string | null; scripts: Record<string, string>; main?: string; bin?: unknown } | null {
  const absolute = path.join(scope.rootRealPath, 'package.json');
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8')) as {
      name?: unknown;
      scripts?: unknown;
      main?: unknown;
      bin?: unknown;
    };
    const scripts: Record<string, string> = {};
    if (raw.scripts && typeof raw.scripts === 'object' && !Array.isArray(raw.scripts)) {
      for (const [key, value] of Object.entries(raw.scripts)) {
        if (typeof value === 'string' && value.length > 0 && value.length <= 512) {
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

function detectPackageManagers(files: readonly WalkedFile[]): string[] {
  const basenames = new Set(files.map((file) => path.posix.basename(file.relativePath)));
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

export function buildOrientationInventory(
  scope: ProjectExecutionScope,
  walk: OrientationWalkResult,
): OrientationInventory {
  const langMap = new Map<string, { files: number; bytes: number }>();
  const dirMap = new Map<string, { files: number; bytes: number }>();
  let sourceFileCount = 0;
  let bytesScanned = 0;

  for (const file of walk.files) {
    bytesScanned += file.size;
    if (file.isSource) {
      sourceFileCount += 1;
      if (file.language) {
        const current = langMap.get(file.language) ?? { files: 0, bytes: 0 };
        current.files += 1;
        current.bytes += file.size;
        langMap.set(file.language, current);
      }
    }
    const dir = topLevelDir(file.relativePath);
    const dirStat = dirMap.get(dir) ?? { files: 0, bytes: 0 };
    dirStat.files += 1;
    dirStat.bytes += file.size;
    dirMap.set(dir, dirStat);
  }

  const languages: OrientationLanguageStat[] = [...langMap.entries()]
    .map(([id, stat]) => Object.freeze({ id, files: stat.files, bytes: stat.bytes }))
    .sort((left, right) => right.files - left.files || left.id.localeCompare(right.id));

  const topDirs: OrientationDirStat[] = [...dirMap.entries()]
    .map(([dirPath, stat]) =>
      Object.freeze({ path: dirPath, files: stat.files, bytes: stat.bytes }),
    )
    .sort((left, right) => right.files - left.files || left.path.localeCompare(right.path))
    .slice(0, 12);

  const pathSet = new Set(walk.files.map((file) => file.relativePath));
  const manifests = walk.files
    .filter((file) => MANIFEST_NAMES.has(path.posix.basename(file.relativePath)))
    .map((file) => file.relativePath)
    .sort((left, right) => left.localeCompare(right));

  const pkg = readPackageJson(scope);
  const entrypoints = new Set<string>();
  for (const candidate of ENTRYPOINT_CANDIDATES) {
    if (pathSet.has(candidate)) entrypoints.add(candidate);
  }
  if (pkg?.main) {
    const normalized = pkg.main.replace(/^\.\//, '');
    if (pathSet.has(normalized)) entrypoints.add(normalized);
  }

  return Object.freeze({
    languages: Object.freeze(languages),
    topDirs: Object.freeze(topDirs),
    entrypoints: Object.freeze([...entrypoints].sort((a, b) => a.localeCompare(b))),
    manifests: Object.freeze(manifests),
    scripts: Object.freeze(pkg ? pickScripts(pkg.scripts) : {}),
    packageManagers: Object.freeze(detectPackageManagers(walk.files)),
    fileCount: walk.files.length,
    sourceFileCount,
    bytesScanned,
    projectName: pkg?.name ?? null,
  });
}
