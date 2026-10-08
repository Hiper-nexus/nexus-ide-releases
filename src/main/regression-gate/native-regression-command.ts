import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { realUserHome, resolveCliBinary } from '../path-resolver';
import { discoverScopedGoWorkspace } from './go-workspace';

interface ProbeOptions { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
interface NativeCommandPorts {
  resolve(name: string): string | null;
  home(): string;
  probe(file: string, args: readonly string[], options: ProbeOptions): Promise<string>;
}
interface NativeCommandOptions {
  rootRealPath?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  ports?: Partial<NativeCommandPorts>;
}
export interface NativeRegressionCommand {
  file: string;
  argsPrefix?: readonly string[];
  env: NodeJS.ProcessEnv;
  extraReadPaths: readonly string[];
  workspaceModuleRoots?: readonly string[];
}
const ENV_KEYS = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR'];
const defaults: NativeCommandPorts = {
  resolve: name => resolveCliBinary(name)?.binPath ?? null,
  home: realUserHome,
  probe: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true },
      (error, stdout) => error ? reject(new Error('Toolchain instalada indisponível; instale a versão exigida pelo projeto.')) : resolve(stdout.trim()));
  }),
};
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
async function directory(file: string): Promise<boolean> { try { return (await fs.stat(file)).isDirectory(); } catch { return false; } }

async function sdkReadPaths(sdk: string, kind: 'go' | 'cargo', home: string): Promise<string[]> {
  if (inside(sdk, path.resolve(home))) throw new Error('Toolchain não pode conceder leitura do HOME ou de seu ancestral.');
  const result: string[] = [];
  const names = kind === 'cargo' ? ['bin', 'lib'] : ['bin', 'src', 'pkg', 'lib', 'VERSION', 'go.env'];
  for (const name of names) {
    const candidate = path.join(sdk, name);
    try {
      const real = await fs.realpath(candidate);
      if (!inside(sdk, real) || inside(real, path.resolve(home))) throw new Error('Toolchain contém leitura fora do SDK autorizado.');
      result.push(real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ['bin', 'lib'].includes(name) && kind === 'cargo') throw error;
    }
  }
  return [...new Set(result)];
}
async function validateGoWorkspace(file: string, root: string, json: string): Promise<void> {
  const doc = JSON.parse(json) as { Use?: { DiskPath?: unknown }[]; Replace?: { New?: { Path?: unknown; Version?: unknown } }[] };
  if (!Array.isArray(doc.Use) || doc.Use.length > 512 || doc.Replace !== undefined && !Array.isArray(doc.Replace)) throw new Error('Workspace Go não pôde ser comprovado.');
  const paths = [...doc.Use.map(row => row.DiskPath), ...(doc.Replace ?? []).filter(row => !row.New?.Version).map(row => row.New?.Path)];
  if (paths.length > 1024) throw new Error('Workspace Go excedeu o limite de módulos.');
  for (const value of paths) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('Workspace Go contém módulo inválido.');
    const dir = await fs.realpath(path.resolve(path.dirname(file), value));
    if (!inside(root, dir) || !await directory(dir)) throw new Error('Workspace Go inclui módulo fora do projeto autorizado.');
  }
}

/** Resolve installed SDKs before confinement. Probes never run a project-owned
 * executable or install a toolchain; the actual checks use the owned sandbox. */
export async function prepareNativeRegressionCommand(
  kind: 'go' | 'cargo', cwd: string, sandboxDir: string, baseEnv: NodeJS.ProcessEnv,
  options: NativeCommandOptions = {},
): Promise<NativeRegressionCommand> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const env: NodeJS.ProcessEnv = Object.fromEntries(ENV_KEYS.filter(key => baseEnv[key] !== undefined).map(key => [key, baseEnv[key]]));
  const platform = options.platform ?? process.platform;
  let workspaceModuleRoots: readonly string[] | undefined;
  const scratch = platform === 'win32' ? '/nexus-runtime' : await fs.realpath(sandboxDir);
  const join = platform === 'win32' ? path.posix.join : path.join;
  const privateEnv: NodeJS.ProcessEnv = kind === 'go' ? {
    GOPATH: join(scratch, 'native', 'go'), GOCACHE: join(scratch, 'native', 'go-cache'),
    GOMODCACHE: join(scratch, 'native', 'go', 'pkg', 'mod'), GOTMPDIR: join(scratch, 'tmp'),
    GOENV: 'off', GOTOOLCHAIN: 'local', GOMAXPROCS: '1', GOWORK: 'off',
  } : {
    CARGO_HOME: join(scratch, 'native', 'cargo'), CARGO_TARGET_DIR: join(scratch, 'native', 'target'),
    CARGO_BUILD_JOBS: '1', RUSTUP_AUTO_INSTALL: '0',
  };
  // OCI's canonical launcher deliberately forwards only a tiny fixed env.
  // env(1) applies these Main-generated assignments inside its existing mounts.
  if (platform === 'win32') {
    if (kind === 'go' && options.rootRealPath) {
      const root = await fs.realpath(options.rootRealPath);
      const workspace = await discoverScopedGoWorkspace(cwd, root);
      const work = workspace?.file; workspaceModuleRoots = workspace?.moduleRoots;
      // OCI exposes this project and private scratch only; no other host module is mounted.
      if (work) privateEnv.GOWORK = `/workspace/${path.relative(root, work).split(path.sep).join('/')}`;
    }
    assertCurrent();
    return { file: 'env', argsPrefix: [
    ...Object.entries(privateEnv).map(([key, value]) => `${key}=${value}`), kind,
    ], env, extraReadPaths: [], workspaceModuleRoots };
  }

  const ports = { ...defaults, ...options.ports };
  const root = await fs.realpath(options.rootRealPath ?? cwd);
  const resolveTool = async (name: string): Promise<string> => {
    const raw = ports.resolve(name);
    if (!raw) throw new Error(`Toolchain ${name} indisponível; instale-a antes de executar os testes.`);
    const file = await fs.realpath(raw);
    if (inside(root, file)) throw new Error('Toolchain dentro do projeto não pode ser sondada fora do sandbox.');
    if (!(await fs.stat(file)).isFile()) throw new Error('Toolchain executável inválida.');
    return file;
  };
  const rustTool = async (name: 'cargo' | 'rustc' | 'rustdoc') => {
    let file = await resolveTool(name);
    if (path.basename(file) === 'rustup') {
      const probeEnv = { ...env, HOME: ports.home(), RUSTUP_AUTO_INSTALL: '0' };
      // These are rustup selection settings, not the Cargo credential/profile.
      for (const key of ['RUSTUP_HOME', 'RUSTUP_TOOLCHAIN'] as const) {
        const value = process.env[key];
        if (value && value.length <= 4096 && !/[\0\r\n]/.test(value)) (probeEnv as NodeJS.ProcessEnv)[key] = value;
      }
      assertCurrent();
      const resolved = await ports.probe(file, ['which', name], { cwd, env: probeEnv, signal: options.signal });
      assertCurrent();
      if (!path.isAbsolute(resolved) || /[\0\r\n]/.test(resolved)) throw new Error('Toolchain retornou caminho inválido.');
      file = await fs.realpath(resolved);
      if (inside(root, file) || !(await fs.stat(file)).isFile()) throw new Error('Toolchain Rust fora da autoridade de execução.');
    }
    const sdk = path.dirname(path.dirname(file));
    if (path.basename(path.dirname(file)) !== 'bin' || !await directory(path.join(sdk, 'lib', 'rustlib'))) throw new Error('Toolchain Rust não pôde ser comprovada.');
    return { file, sdk };
  };
  for (const dir of ['home', 'tmp', 'native']) await fs.mkdir(path.join(scratch, dir), { recursive: true, mode: 0o700 });
  let file: string; let roots: string[];
  if (kind === 'go') {
    file = await resolveTool('go');
    const sdk = path.dirname(path.dirname(file));
    if (path.basename(path.dirname(file)) !== 'bin' || !await directory(path.join(sdk, 'src', 'runtime')) || !await directory(path.join(sdk, 'pkg', 'tool'))) {
      throw new Error('Toolchain Go não pôde ser comprovada; instale uma distribuição completa.');
    }
    privateEnv.GOROOT = sdk; roots = [sdk];
    const workspace = await discoverScopedGoWorkspace(cwd, root);
    const work = workspace?.file; workspaceModuleRoots = workspace?.moduleRoots;
    if (work) {
      const json = await ports.probe(file, ['work', 'edit', '-json', work], { cwd,
        env: { ...env, ...privateEnv, HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp') }, signal: options.signal });
      assertCurrent(); await validateGoWorkspace(work, root, json);
      privateEnv.GOWORK = work;
    }
  } else {
    const [cargo, rustc, rustdoc] = await Promise.all([rustTool('cargo'), rustTool('rustc'), rustTool('rustdoc')]);
    file = cargo.file; roots = [...new Set([cargo.sdk, rustc.sdk, rustdoc.sdk])];
    privateEnv.RUSTC = rustc.file; privateEnv.RUSTDOC = rustdoc.file;
  }
  assertCurrent();
  const extraReadPaths = (await Promise.all(roots.map(sdk => sdkReadPaths(sdk, kind, ports.home())))).flat();
  assertCurrent();
  return { file, argsPrefix: [], extraReadPaths: [...new Set(extraReadPaths)], workspaceModuleRoots,
    env: { ...env, ...privateEnv, HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp'),
      PATH: [...new Set(roots.map(sdk => path.join(sdk, 'bin'))), env.PATH ?? ''].filter(Boolean).join(path.delimiter) } };
}
