import { spawn } from 'node:child_process';
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
  verifyPython?: (python: string) => boolean | Promise<boolean>;
}

const PYTHON_VERIFY_TIMEOUT_MS = 5_000;

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.promises.access(
      file,
      process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function optionalExecutable(file: string): Promise<string | undefined> {
  return (await isExecutable(file)) ? file : undefined;
}

async function optionalDirectory(dir: string): Promise<string | undefined> {
  try {
    return (await fs.promises.stat(dir)).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function hasPillow(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(
      python,
      ['-c', 'from PIL import Image; print(Image.__version__)'],
      { stdio: 'ignore', shell: false },
    );
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, PYTHON_VERIFY_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

async function codexRuntimeRoots(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const runtimeHome = path.join(home, '.cache', 'codex-runtimes');
  let discovered: string[] = [];
  try {
    discovered = (await fs.promises
      .readdir(runtimeHome, { withFileTypes: true }))
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

async function bundledDependencies(
  root: string,
  verifyPython: (python: string) => boolean | Promise<boolean>,
): Promise<WorkspaceDependencies | null> {
  const python = await optionalExecutable(
    path.join(root, 'python', 'bin', process.platform === 'win32' ? 'python.exe' : 'python3'),
  );
  if (!python || !(await verifyPython(python))) return null;

  const [
    fallbackBin,
    overrideBin,
    nodePackages,
    git,
    node,
    pnpm,
    pythonPackages,
  ] = await Promise.all([
    optionalDirectory(path.join(root, 'bin', 'fallback')),
    optionalDirectory(path.join(root, 'bin', 'override')),
    optionalDirectory(path.join(root, 'node', 'node_modules')),
    optionalExecutable(
      path.join(root, 'bin', 'fallback', process.platform === 'win32' ? 'git.exe' : 'git'),
    ),
    optionalExecutable(
      path.join(root, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    ),
    optionalExecutable(
      path.join(root, 'bin', 'fallback', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    ),
    optionalDirectory(path.join(root, 'python')),
  ]);
  return {
    source: 'codex-runtime',
    root,
    git,
    node,
    nodePackages,
    pnpm,
    python,
    pythonPackages,
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
export async function resolveWorkspaceDependencies(
  options: WorkspaceDependencyOptions = {},
): Promise<WorkspaceDependencies> {
  const home = path.resolve(options.home ?? os.homedir());
  const env = options.env ?? process.env;
  const verifyPython = options.verifyPython ?? hasPillow;

  for (const root of await codexRuntimeRoots(home, env)) {
    const dependencies = await bundledDependencies(root, verifyPython);
    if (dependencies) return dependencies;
  }
  for (const python of pythonCandidates(env)) {
    if ((await isExecutable(python)) && (await verifyPython(python))) {
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
