import { execFile } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The pinned video engine (F-1594): HyperFrames (Apache-2.0, HeyGen), chosen
 * over Remotion in the study of 19/10/2026 (§1.2, §5.2.1). The Nexus installs
 * this exact version from the lockfile it ships, with `--ignore-scripts`, in
 * a short folder under userData, and runs it with an allowlisted environment:
 * no API key, telemetry off, no skill installs, no update checks, and a
 * Nexus-owned HOME so its caches and config never touch the user's profile.
 */

export const HYPERFRAMES_VERSION = '0.8.177';
export const MIN_NODE_MAJOR = 22;

export interface VideoEnginePaths {
  /** `<userData>/video-engines` */
  readonly root: string;
  /** Installed engine (package.json, lockfile, node_modules, marker). */
  readonly engineDir: string;
  readonly cliEntry: string;
  readonly marker: string;
  /** HOME/USERPROFILE of the engine: Chrome cache, ~/.hyperframes config. */
  readonly home: string;
  /** Empty cwd: the CLI reads `.env` from its cwd, never from the project. */
  readonly workDir: string;
}

export function videoEnginePaths(userData: string): VideoEnginePaths {
  const root = path.join(userData, 'video-engines');
  // Short names on purpose: the Windows path limit (260) broke Remotion's
  // Chrome in the prototype; node_modules and the Chrome cache live below.
  const engineDir = path.join(root, `hf-${HYPERFRAMES_VERSION}`);
  return {
    root,
    engineDir,
    cliEntry: path.join(engineDir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'),
    marker: path.join(engineDir, '.nexus-engine.json'),
    home: path.join(root, 'home'),
    workDir: path.join(root, 'cwd'),
  };
}

/** Where the shipped package.json + lockfile live (resources/video-engines/hyperframes). */
export function bundledEngineManifestDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'video-engines', 'hyperframes')
    : path.join(app.getAppPath(), 'resources', 'video-engines', 'hyperframes');
}

/**
 * Environment variables the engine may inherit. Everything else — every
 * `*_API_KEY`, token, cloud credential, NODE_OPTIONS — is dropped.
 */
const INHERITED_ENV = [
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Windows: user fonts live under LOCALAPPDATA; npm keeps its cache there.
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'XDG_RUNTIME_DIR',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  // Corporate networks: npm ci needs the proxy to reach the registry.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Fixed policy of every engine process (study §5.2.6). */
export const ENGINE_POLICY_ENV: Readonly<Record<string, string>> = {
  HYPERFRAMES_NO_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
  HYPERFRAMES_SKIP_SKILLS: '1',
  HYPERFRAMES_NO_UPDATE_CHECK: '1',
  HYPERFRAMES_NO_AUTO_INSTALL: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

export function buildEngineEnv(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly pathValue: string;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
}): Record<string, string> {
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = input.base[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  env[platform === 'win32' ? 'Path' : 'PATH'] = input.pathValue;
  env.HOME = input.home;
  if (platform === 'win32') env.USERPROFILE = input.home;
  return { ...env, ...ENGINE_POLICY_ENV };
}

// ── Project detection ───────────────────────────────────────────────────────

export const REMOTION_REFUSAL =
  'Projeto Remotion: o Nexus não renderiza Remotion. A licença do Remotion é paga para empresa ' +
  'com 4 pessoas ou mais e os termos da versão 5 vedam embuti-lo numa IDE (estudo de 19/10/2026, §1.2). ' +
  'Renderize pelo shell do pane com o próprio Remotion do projeto (npx remotion render), sob a ' +
  'licença de quem é dono do projeto, ou faça o vídeo em HyperFrames.';

export type VideoProjectKind = 'hyperframes' | 'remotion' | 'unknown';

function readText(file: string, max = 512 * 1024): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function detectVideoProject(dir: string): VideoProjectKind {
  const pkg = readText(path.join(dir, 'package.json'));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      const deps = { ...(parsed.dependencies as object), ...(parsed.devDependencies as object) };
      if (Object.keys(deps).some((name) => name === 'remotion' || name.startsWith('@remotion/'))) {
        return 'remotion';
      }
    } catch {
      // package.json ilegível não decide nada
    }
  }
  if (['remotion.config.ts', 'remotion.config.js', 'remotion.config.mjs'].some((name) => fs.existsSync(path.join(dir, name)))) {
    return 'remotion';
  }
  if (fs.existsSync(path.join(dir, 'hyperframes.json'))) return 'hyperframes';
  const index = readText(path.join(dir, 'index.html'), 4 * 1024 * 1024);
  if (index && /data-composition-id|data-composition|__timelines/u.test(index)) return 'hyperframes';
  return 'unknown';
}

// ── Host tools ──────────────────────────────────────────────────────────────

export interface NodeRuntime {
  readonly version: string;
  readonly major: number;
  /** Real node binary (a version-manager shim resolves to it). */
  readonly execPath: string;
  /** npm's CLI script next to that node; run as `node npm-cli.js` (never a .cmd). */
  readonly npmCli: string | null;
}

function execFileText(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

export function npmCliCandidates(execPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const dir = path.dirname(execPath);
  const posix = platform !== 'win32';
  return posix
    ? [
        path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
}

/** Ask the `node` on PATH for its real version and binary. */
export async function resolveNodeRuntime(input: {
  readonly nodeOnPath: string | null;
  readonly env: Record<string, string>;
  readonly exists?: (file: string) => boolean;
}): Promise<NodeRuntime | null> {
  if (!input.nodeOnPath) return null;
  let out: string;
  try {
    out = await execFileText(
      input.nodeOnPath,
      ['-p', 'process.version + "|" + process.execPath'],
      input.env,
      10_000,
    );
  } catch {
    return null;
  }
  const [version, execPath] = out.trim().split('|');
  const major = Number(/^v(\d+)\./u.exec(version ?? '')?.[1]);
  if (!Number.isFinite(major) || !execPath) return null;
  const exists = input.exists ?? ((file: string) => fs.existsSync(file));
  const npmCli = npmCliCandidates(execPath).find(exists) ?? null;
  return { version, major, execPath, npmCli };
}

/** First line of `<tool> -version` (ffmpeg/ffprobe), or null when it does not run. */
export async function toolVersion(
  file: string | null,
  env: Record<string, string>,
): Promise<string | null> {
  if (!file) return null;
  try {
    const out = await execFileText(file, ['-version'], env, 10_000);
    return out.split(/\r?\n/u)[0]?.slice(0, 160) ?? null;
  } catch {
    return null;
  }
}
