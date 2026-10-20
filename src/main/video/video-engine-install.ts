import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { removeTreeSync } from '../util/remove-tree';
import { HYPERFRAMES_VERSION, type NodeRuntime, type VideoEnginePaths } from './video-engine';
import { runOwnedProcess, type OwnedProcessResult } from './video-process';

/**
 * Install of the pinned engine (F-1594). Supply-chain rules of the study
 * (§5.6): the exact version and every transitive package come from the
 * lockfile the app ships (integrity-checked by `npm ci`), install scripts
 * never run (`--ignore-scripts`), the install lands in a staging folder and
 * only an install that proves the pinned version replaces the current one.
 * Updating the engine is a reviewed change to that lockfile, never @latest.
 */

const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface EngineMarker {
  readonly version: string;
  readonly lockSha256: string;
  readonly installedAt: string;
}

export type EngineState =
  | { readonly status: 'ready'; readonly marker: EngineMarker }
  | { readonly status: 'missing' }
  | { readonly status: 'outdated'; readonly marker: EngineMarker };

export function lockfileSha256(manifestDir: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(manifestDir, 'package-lock.json'))).digest('hex');
}

export function readEngineState(paths: VideoEnginePaths, manifestDir: string): EngineState {
  let marker: EngineMarker;
  try {
    marker = JSON.parse(fs.readFileSync(paths.marker, 'utf8')) as EngineMarker;
  } catch {
    return { status: 'missing' };
  }
  const current =
    marker.version === HYPERFRAMES_VERSION &&
    marker.lockSha256 === lockfileSha256(manifestDir) &&
    fs.existsSync(paths.cliEntry);
  return current ? { status: 'ready', marker } : { status: 'outdated', marker };
}

export interface EngineInstallInput {
  readonly paths: VideoEnginePaths;
  readonly manifestDir: string;
  readonly node: NodeRuntime;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly run?: typeof runOwnedProcess;
}

export type EngineInstallResult =
  | { readonly ok: true; readonly installed: 'already' | 'now'; readonly version: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: string };

function npmFailure(result: OwnedProcessResult): string {
  if (result.aborted) return 'instalação do motor de vídeo cancelada';
  if (result.timedOut) return 'a instalação do motor de vídeo passou de 10 minutos';
  const lines = result.tail.filter((line) => /npm (ERR|error)|ERR!|E404|ETIMEDOUT|ENOTFOUND|EINTEGRITY/iu.test(line));
  const detail = (lines.length ? lines : result.tail).slice(-6).join(' | ').slice(0, 600);
  return `npm ci do motor de vídeo falhou${result.spawnError ? ` (${result.spawnError})` : ''}${detail ? `: ${detail}` : ''}`;
}

let inFlight: Promise<EngineInstallResult> | null = null;

/** Install (or reuse) the pinned engine. Concurrent callers share one install. */
export function ensureVideoEngine(input: EngineInstallInput): Promise<EngineInstallResult> {
  if (readEngineState(input.paths, input.manifestDir).status === 'ready') {
    return Promise.resolve({ ok: true, installed: 'already', version: HYPERFRAMES_VERSION, durationMs: 0 });
  }
  inFlight ??= installVideoEngine(input).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function installVideoEngine(input: EngineInstallInput): Promise<EngineInstallResult> {
  const startedAt = Date.now();
  if (!input.node.npmCli) {
    return { ok: false, error: 'npm não encontrado ao lado do Node; reinstale o Node.js 22 ou mais novo.' };
  }
  const { paths } = input;
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.workDir, { recursive: true });
  const staging = path.join(paths.root, `.st-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    for (const name of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(input.manifestDir, name), path.join(staging, name));
    }
    const result = await (input.run ?? runOwnedProcess)({
      file: input.node.execPath,
      args: [
        input.node.npmCli,
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      cwd: staging,
      env: input.env,
      signal: input.signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return { ok: false, error: npmFailure(result) };
    const installed = JSON.parse(
      fs.readFileSync(path.join(staging, 'node_modules', 'hyperframes', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (installed.version !== HYPERFRAMES_VERSION) {
      return { ok: false, error: `o npm instalou hyperframes ${String(installed.version)}, não ${HYPERFRAMES_VERSION}` };
    }
    const marker: EngineMarker = {
      version: HYPERFRAMES_VERSION,
      lockSha256: lockfileSha256(input.manifestDir),
      installedAt: (input.now?.() ?? new Date()).toISOString(),
    };
    fs.writeFileSync(path.join(staging, '.nexus-engine.json'), `${JSON.stringify(marker, null, 2)}\n`);
    if (fs.existsSync(paths.engineDir)) removeTreeSync(paths.engineDir);
    fs.renameSync(staging, paths.engineDir);
    return { ok: true, installed: 'now', version: HYPERFRAMES_VERSION, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: `instalação do motor de vídeo falhou: ${(error as Error).message}` };
  } finally {
    if (fs.existsSync(staging)) removeTreeSync(staging);
  }
}
