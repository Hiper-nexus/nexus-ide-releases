import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorkspaceDependencies {
  source: 'codex-runtime' | 'system-python';
  root?: string;
  git?: string;
  node?: string;
  nodePackages?: string;
  pnpm?: string;
  python: string;
  pythonPackages?: string;
  overrideBin?: string;
  fallbackBin?: string;
}

export interface WorkspaceDependencyOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  verifyPython?: (python: string) => boolean;
}

const PYTHON_VERIFY_TIMEOUT_MS = 5_000;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(
      file,
      process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function optionalExecutable(file: string): string | undefined {
  return isExecutable(file) ? file : undefined;
}

function optionalDirectory(dir: string): string | undefined {
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function hasPillow(python: string): boolean {
  const result = spawnSync(
    python,
    ['-c', 'from PIL import Image; print(Image.__version__)'],
    { stdio: 'ignore', timeout: PYTHON_VERIFY_TIMEOUT_MS },
  );
  return result.status === 0 && !result.error;
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function codexRuntimeRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  const runtimeHome = path.join(home, '.cache', 'codex-runtimes');
  let discovered: string[] = [];
  try {
    discovered = fs
      .readdirSync(runtimeHome, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runtimeHome, entry.name, 'dependencies'));
  } catch {
    // A machine without Codex Desktop may still provide a compatible Python.
  }
  return unique([
    env.NEXUS_WORKSPACE_DEPENDENCIES_ROOT,
    path.join(runtimeHome, 'codex-primary-runtime', 'dependencies'),
    ...discovered,
  ]).map((candidate) => path.resolve(candidate));
}

function bundledDependencies(
  root: string,
  verifyPython: (python: string) => boolean,
): WorkspaceDependencies | null {
  const python = optionalExecutable(
    path.join(root, 'python', 'bin', process.platform === 'win32' ? 'python.exe' : 'python3'),
  );
  if (!python || !verifyPython(python)) return null;

  const fallbackBin = optionalDirectory(path.join(root, 'bin', 'fallback'));
  const overrideBin = optionalDirectory(path.join(root, 'bin', 'override'));
  const nodePackages = optionalDirectory(path.join(root, 'node', 'node_modules'));
  return {
    source: 'codex-runtime',
    root,
    git: optionalExecutable(
      path.join(root, 'bin', 'fallback', process.platform === 'win32' ? 'git.exe' : 'git'),
    ),
    node: optionalExecutable(
      path.join(root, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    ),
    nodePackages,
    pnpm: optionalExecutable(
      path.join(root, 'bin', 'fallback', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    ),
    python,
    pythonPackages: optionalDirectory(path.join(root, 'python')),
    overrideBin,
    fallbackBin,
  };
}

function pythonCandidates(env: NodeJS.ProcessEnv): string[] {
  const executableNames =
    process.platform === 'win32'
      ? ['python.exe', 'python3.exe']
      : ['python3', 'python'];
  const fromPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => executableNames.map((name) => path.join(dir, name)));
  return unique([
    env.NEXUS_WORKSPACE_PYTHON,
    env.CODEX_WORKSPACE_PYTHON,
    ...fromPath,
  ]).map((candidate) => path.resolve(candidate));
}

/**
 * Resolve the same Pillow-capable runtime that Codex Desktop exposes to its
 * document/media skills. Nexus panes are independent CLI processes, so this
 * bridge makes that implicit Desktop dependency explicit and testable.
 */
export function resolveWorkspaceDependencies(
  options: WorkspaceDependencyOptions = {},
): WorkspaceDependencies {
  const home = path.resolve(options.home ?? os.homedir());
  const env = options.env ?? process.env;
  const verifyPython = options.verifyPython ?? hasPillow;

  for (const root of codexRuntimeRoots(home, env)) {
    const dependencies = bundledDependencies(root, verifyPython);
    if (dependencies) return dependencies;
  }
  for (const python of pythonCandidates(env)) {
    if (isExecutable(python) && verifyPython(python)) {
      return { source: 'system-python', python };
    }
  }

  throw new Error(
    'O runtime de dependências com Python + Pillow não foi encontrado. ' +
      'Abra o Codex Desktop uma vez para instalar o runtime, ou defina ' +
      'NEXUS_WORKSPACE_DEPENDENCIES_ROOT para um pacote compatível.',
  );
}

function line(label: string, value: string | undefined): string | null {
  return value ? `- ${label}: \`${value}\`` : null;
}

/** Desktop-compatible, agent-readable response with exact executable paths. */
export function formatWorkspaceDependencies(
  dependencies: WorkspaceDependencies,
): string {
  return [
    'Workspace dependencies are available for this Nexus pane.',
    '',
    '### Workspace Dependencies',
    line('Source', dependencies.source),
    line('Git executable', dependencies.git),
    line('Node.js executable', dependencies.node),
    line('Node.js packages', dependencies.nodePackages),
    line('pnpm executable', dependencies.pnpm),
    line('Python executable', dependencies.python),
    line('Python packages', dependencies.pythonPackages),
    line('Override binaries', dependencies.overrideBin),
    line('Fallback binaries', dependencies.fallbackBin),
    '',
    'Use the exact Python executable above; Pillow has already been verified.',
  ]
    .filter((value): value is string => value !== null)
    .join('\n');
}
