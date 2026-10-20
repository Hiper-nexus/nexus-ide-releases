import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { registerExternalPreview, unregisterExternalPreview } from '../orch/preview-server';
import {
  buildEngineEnv,
  detectVideoProject,
  HYPERFRAMES_VERSION,
  MIN_NODE_MAJOR,
  REMOTION_REFUSAL,
  resolveNodeRuntime,
  videoEnginePaths,
} from './video-engine';
import { ensureVideoEngine } from './video-engine-install';
import { installHint } from './video-doctor';
import { killProcessTree } from './video-process';
import { resolveWorkspaceDir } from './video-render';

/**
 * Live preview (F-1603, study §5.3 step 11): the HyperFrames Studio of a
 * project, started by the Nexus in the same clean environment as the render
 * (pinned CLI, no keys, telemetry off) and registered as a trusted browser
 * target while the process lives, like the Nexus's own static previews.
 *
 * The Studio is a long-running Main-owned child (`--foreground`, never the
 * CLI's `--background` daemon, which would outlive the Nexus): stopping kills
 * the whole tree, and every preview dies with the app. Before the URL is
 * trusted, `/__hyperframes_config` must answer from OUR child (same pid) for
 * the project we asked for — a random service on the port is never trusted.
 */

export interface PreviewRequest {
  readonly projectDir: string;
  readonly baseDir: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly assertCurrentAuthority?: () => void;
  readonly signal?: AbortSignal;
}

export interface PreviewDeps {
  readonly userData: string;
  readonly manifestDir: string;
  readonly pathValue: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly lookup: (command: string) => string | null;
  readonly isHardened: () => boolean;
  readonly spawnFn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly ensureEngine?: typeof ensureVideoEngine;
  readonly resolveNode?: typeof resolveNodeRuntime;
  readonly fetchFn?: typeof fetch;
  readonly freePort?: () => Promise<number>;
  readonly readyTimeoutMs?: number;
}

export interface VideoPreviewInfo {
  readonly id: string;
  readonly url: string;
  readonly port: number;
  /** Workspace-relative project folder. */
  readonly project: string;
}

export type PreviewStartResult =
  | (VideoPreviewInfo & { readonly ok: true; readonly reused: boolean })
  | { readonly ok: false; readonly error: string; readonly log?: readonly string[] };

interface LivePreview {
  readonly id: string;
  readonly key: string;
  readonly port: number;
  readonly projectDir: string;
  readonly project: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly child: ChildProcess;
  readonly killTree: (pid: number) => Promise<void>;
  stopping: Promise<void> | null;
}

export const MAX_LIVE_PREVIEWS = 3;
const READY_TIMEOUT_MS = 60_000;
const SERVER_LINE = /\bServer\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/u;

const live = new Map<string, LivePreview>();
const starting = new Map<string, Promise<PreviewStartResult>>();

function previewKey(scope: Readonly<ProjectExecutionScope>, projectDir: string): string {
  return JSON.stringify([scope.projectId, scope.checkoutId, projectDir.toLowerCase()]);
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => path.resolve(value).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();
  return norm(a) === norm(b);
}

function info(entry: LivePreview): VideoPreviewInfo {
  return {
    id: entry.id,
    url: `http://127.0.0.1:${entry.port}/#project/${encodeURIComponent(path.basename(entry.projectDir))}`,
    port: entry.port,
    project: entry.project,
  };
}

function defaultFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** `/__hyperframes_config` proves the server is our child, serving our project. */
export async function probeStudio(
  port: number,
  expected: { pid: number; projectDir: string },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/__hyperframes_config`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return (
      body.isHyperframes === true &&
      body.pid === expected.pid &&
      typeof body.projectDir === 'string' &&
      samePath(body.projectDir, expected.projectDir)
    );
  } catch {
    return false;
  }
}

export async function startVideoPreview(req: PreviewRequest, deps: PreviewDeps): Promise<PreviewStartResult> {
  if (deps.isHardened()) {
    return {
      ok: false,
      error:
        'Modo Hardened: a prévia executa o código do projeto e fica desligada neste modo. ' +
        `Use npx hyperframes@${HYPERFRAMES_VERSION} preview pelo shell do pane, dentro da sandbox.`,
    };
  }
  req.assertCurrentAuthority?.();
  let projectDir: string;
  try {
    projectDir = resolveWorkspaceDir(req.projectDir, req.baseDir);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const kind = detectVideoProject(projectDir);
  if (kind === 'remotion') return { ok: false, error: REMOTION_REFUSAL };
  if (kind === 'unknown') {
    return {
      ok: false,
      error: `Isto não parece um projeto HyperFrames (falta hyperframes.json ou um index.html com data-composition).`,
    };
  }
  const key = previewKey(req.scope, projectDir);
  for (const entry of live.values()) {
    if (entry.key === key && !entry.stopping) return { ok: true, reused: true, ...info(entry) };
  }
  const pending = starting.get(key);
  if (pending) return pending;
  const run = launch(req, deps, projectDir, key);
  starting.set(key, run);
  try {
    return await run;
  } finally {
    if (starting.get(key) === run) starting.delete(key);
  }
}

async function launch(
  req: PreviewRequest,
  deps: PreviewDeps,
  projectDir: string,
  key: string,
): Promise<PreviewStartResult> {
  if (live.size + starting.size >= MAX_LIVE_PREVIEWS) {
    return {
      ok: false,
      error: `Já há ${MAX_LIVE_PREVIEWS} prévias de vídeo abertas; feche uma (nexus_video_preview_stop) antes de abrir outra.`,
    };
  }
  const paths = videoEnginePaths(deps.userData);
  const env = buildEngineEnv({ base: deps.baseEnv, pathValue: deps.pathValue, home: paths.home });
  const node = await (deps.resolveNode ?? resolveNodeRuntime)({ nodeOnPath: deps.lookup('node'), env });
  if (!node || node.major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      error: `A prévia precisa do Node.js ${MIN_NODE_MAJOR} ou mais novo no PATH. Instale com: ${installHint('node', process.platform)}`,
    };
  }
  fs.mkdirSync(paths.workDir, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  const engine = await (deps.ensureEngine ?? ensureVideoEngine)({
    paths,
    manifestDir: deps.manifestDir,
    node,
    env,
    signal: req.signal,
  });
  if (!engine.ok) return { ok: false, error: engine.error };
  req.assertCurrentAuthority?.();

  const requestedPort = await (deps.freePort ?? defaultFreePort)();
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid));
  const child = (deps.spawnFn ?? ((file, args, options) => spawn(file, [...args], options)))(
    node.execPath,
    [paths.cliEntry, 'preview', projectDir, `--port=${requestedPort}`, '--no-open', '--force-new', '--foreground'],
    {
      cwd: paths.workDir,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const tail: string[] = [];
  let announcedPort: number | null = null;
  let exited = false;
  const onData = (chunk: Buffer | string) => {
    // eslint-disable-next-line no-control-regex -- motivo: tira cores ANSI da saída do CLI antes de ler a porta
    for (const raw of String(chunk).replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line) continue;
      tail.push(line.slice(0, 300));
      if (tail.length > 40) tail.shift();
      const match = SERVER_LINE.exec(line);
      if (match && announcedPort === null) announcedPort = Number(match[1]);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });

  const deadline = Date.now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
  let port: number | null = null;
  while (Date.now() < deadline && !exited && !req.signal?.aborted) {
    const candidate = announcedPort ?? requestedPort;
    if (child.pid !== undefined && (await probeStudio(candidate, { pid: child.pid, projectDir }, deps.fetchFn))) {
      port = candidate;
      break;
    }
    await wait(300);
  }
  if (port === null) {
    const error = req.signal?.aborted
      ? 'prévia cancelada'
      : exited
        ? 'o Studio do HyperFrames encerrou antes de abrir a prévia'
        : 'o Studio do HyperFrames não respondeu a tempo';
    if (child.pid !== undefined) await killTree(child.pid);
    return { ok: false, error, log: tail.slice(-12) };
  }
  try {
    req.assertCurrentAuthority?.();
  } catch (error) {
    if (child.pid !== undefined) await killTree(child.pid);
    throw error;
  }

  const entry: LivePreview = {
    id: `vpreview-${randomUUID()}`,
    key,
    port,
    projectDir,
    project: path.relative(fs.realpathSync(req.baseDir), projectDir).replace(/\\/gu, '/') || '.',
    projectId: req.scope.projectId,
    checkoutId: req.scope.checkoutId,
    child,
    killTree,
    stopping: null,
  };
  live.set(entry.id, entry);
  registerExternalPreview({
    id: entry.id,
    port,
    root: projectDir,
    projectId: entry.projectId,
    checkoutId: entry.checkoutId,
  });
  child.once('exit', () => forget(entry.id));
  return { ok: true, reused: false, ...info(entry) };
}

function forget(id: string): void {
  live.delete(id);
  unregisterExternalPreview(id);
}

function ownedBy(entry: LivePreview, scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>): boolean {
  return entry.projectId === scope.projectId && entry.checkoutId === scope.checkoutId;
}

/** Stops one preview of this project/checkout; resolves after the tree is gone. */
export async function stopVideoPreview(
  id: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): Promise<boolean> {
  const entry = live.get(id);
  if (!entry || !ownedBy(entry, scope)) return false;
  // Untrusted from this moment, even before the process is gone.
  unregisterExternalPreview(id);
  entry.stopping ??= entry.child.pid !== undefined ? entry.killTree(entry.child.pid) : Promise.resolve();
  await entry.stopping;
  forget(id);
  return true;
}

export function listVideoPreviews(scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>): VideoPreviewInfo[] {
  return [...live.values()].filter((entry) => ownedBy(entry, scope) && !entry.stopping).map(info);
}

/** App shutdown: every Studio dies with the Nexus. */
export async function stopAllVideoPreviews(): Promise<void> {
  const entries = [...live.values()];
  await Promise.all(
    entries.map(async (entry) => {
      unregisterExternalPreview(entry.id);
      entry.stopping ??= entry.child.pid !== undefined ? entry.killTree(entry.child.pid) : Promise.resolve();
      await entry.stopping.catch(() => undefined);
      forget(entry.id);
    }),
  );
}
