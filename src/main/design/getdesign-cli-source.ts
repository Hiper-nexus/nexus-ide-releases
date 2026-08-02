import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The npx child-env allowlist is shared with the Dembrandt wrapper: same
// threat model (untrusted npm package, no secret passthrough), same list.
import { buildDembrandtChildEnv as buildNpxChildEnv } from './dembrandt-extractor';
import {
  toDesignKit,
  type DesignKit,
  type DesignKitSource,
  type DesignKitSummary,
} from './design-kit-source';

/**
 * `getdesign` CLI kit source — the open half of the catalog.
 *
 * designmd.ai gates the DESIGN.md body behind an API key (its `/raw` endpoint
 * answers 401 without one, MIT license or not). The `getdesign` CLI publishes
 * the same curated analyses with no credential whatsoever, which is what makes
 * "the design system must actually be used" independent of any account.
 *
 * The CLI is an untrusted external process and is treated as one:
 * - `shell: false` with a fixed argv; the brand is an argument, never
 *   interpolated into a command string, and must match `GETDESIGN_BRAND_PATTERN`
 *   before it is passed at all.
 * - cwd is a fresh temp directory. It is NEVER the Nexus repo: `npx`/`npm`
 *   rewrite `node_modules`, and this repo's `node_modules` is a shared symlink
 *   that such a write destroys.
 * - env is an allowlist (no secret passthrough), wall-clock timeout, output
 *   byte cap, and process-group teardown on timeout/abort.
 * - The downloaded markdown is DATA. Nothing in it is ever executed; it only
 *   becomes a design contract through the same ContextDraft review flow as
 *   every other source.
 */

export const GETDESIGN_PACKAGE = 'getdesign@latest';
export const GETDESIGN_TIMEOUT_MS = 120_000;
export const GETDESIGN_MAX_OUTPUT_BYTES = 2_000_000;
export const GETDESIGN_MAX_KIT_BYTES = 256 * 1024;
export const GETDESIGN_TERMINATION_GRACE_MS = 2_000;
export const GETDESIGN_MAX_BRAND_CHARS = 64;
export const GETDESIGN_MAX_BRANDS = 512;
/** Lowercase slug: letters, digits, dots and dashes only. No path, no shell. */
export const GETDESIGN_BRAND_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * Offline fallback roster. The live list is asked of the CLI first; this only
 * answers when the CLI cannot run, and callers are told it is a fallback so an
 * absent brand never reads as "this brand does not exist".
 */
export const GETDESIGN_FALLBACK_BRANDS: readonly string[] = [
  'airbnb', 'airtable', 'apple', 'binance', 'bmw', 'bmw-m', 'bugatti', 'cal',
  'clay', 'claude', 'clickhouse', 'coinbase', 'cohere', 'composio', 'cursor',
  'dell-1996', 'discord', 'elevenlabs', 'expo', 'ferrari', 'figma', 'framer',
  'hashicorp', 'hp', 'ibm', 'intercom', 'kraken', 'lamborghini', 'linear.app',
  'lovable', 'mastercard', 'meta', 'minimax', 'mintlify', 'miro', 'mistral.ai',
  'mongodb', 'nike', 'nintendo-2001', 'notion', 'nvidia', 'ollama',
  'opencode.ai', 'pinterest', 'playstation', 'posthog', 'raycast', 'renault',
  'replicate', 'resend', 'revolut', 'runwayml', 'sanity', 'sentry', 'shopify',
  'slack', 'spacex', 'spotify', 'starbucks', 'stripe', 'superhuman',
  'supabase', 'together.ai', 'tesla', 'theverge', 'uber', 'vercel', 'vodafone',
  'voltagent', 'warp', 'webflow', 'wired', 'wise', 'x.ai', 'zapier',
];

export class GetDesignCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GetDesignCliError';
    this.code = code;
  }
}

export interface GetDesignCliRunRequest {
  /** Argv after `npx -y getdesign@latest`. Never a shell string. */
  readonly args: readonly string[];
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

export interface GetDesignCliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export type GetDesignCliRunner = (
  request: GetDesignCliRunRequest,
) => Promise<GetDesignCliRunResult>;

export interface GetDesignSourceOptions {
  /** Injected in tests so no suite ever spawns npx. */
  readonly runCli?: GetDesignCliRunner;
  readonly workDirFactory?: () => string;
  readonly maxKitBytes?: number;
  readonly signal?: AbortSignal;
}

export interface GetDesignBrandList {
  readonly brands: readonly string[];
  /** True when the live CLI could not answer and the static roster was used. */
  readonly isFallback: boolean;
  readonly detail?: string;
}

export function isValidGetDesignBrand(brand: string): boolean {
  return (
    brand.length > 0 &&
    brand.length <= GETDESIGN_MAX_BRAND_CHARS &&
    GETDESIGN_BRAND_PATTERN.test(brand)
  );
}

function assertValidBrand(brand: string): string {
  const normalized = brand.trim().toLowerCase();
  if (!isValidGetDesignBrand(normalized)) {
    throw new GetDesignCliError(
      'INVALID_BRAND',
      'getdesign brand must match ^[a-z0-9][a-z0-9.-]*$ and stay under ' +
        `${GETDESIGN_MAX_BRAND_CHARS} characters`,
    );
  }
  return normalized;
}

// Terminal decoration and list bullets are noise around the brand token.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const LIST_NOISE = /^[\s>*\-•|+]+/;
const NOISE_TOKENS = new Set([
  'available',
  'brands',
  'brand',
  'usage',
  'npx',
  'getdesign',
  'name',
  'list',
  'add',
  'out',
  'total',
  'options',
  'examples',
  'example',
]);

/**
 * The CLI's list format is not a stable contract, so parsing stays deliberately
 * conservative: one candidate token per line, validated against the same brand
 * pattern the argv gate uses.
 */
export function parseGetDesignBrandList(stdout: string): readonly string[] {
  const seen = new Set<string>();
  for (const rawLine of stdout.replace(ANSI_PATTERN, '').split('\n')) {
    const line = rawLine.replace(LIST_NOISE, '').trim().toLowerCase();
    if (line === '') continue;
    const token = line.split(/[\s,|]+/)[0] ?? '';
    if (!isValidGetDesignBrand(token)) continue;
    if (NOISE_TOKENS.has(token)) continue;
    seen.add(token);
    if (seen.size >= GETDESIGN_MAX_BRANDS) break;
  }
  return [...seen];
}

function titleFromBrand(brand: string): string {
  return brand
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function summaryFor(brand: string): DesignKitSummary {
  return {
    sourceId: 'getdesign',
    kitId: brand,
    title: titleFromBrand(brand),
    description: `Curated ${titleFromBrand(brand)} design analysis from the open getdesign catalog.`,
    tags: [],
    license: 'unknown',
    locator: `getdesign:${brand}`,
  };
}

function isAlreadyGone(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}

/**
 * NOT unref'd, deliberately: this is the grace window between SIGTERM and the
 * authoritative SIGKILL of a DETACHED process group. An unref'd timer lets a
 * plain-Node host exit during those two seconds, and the group — which does not
 * die with its parent — outlives the app holding an npm download open. Two
 * seconds of a referenced timer is the cheapest way to guarantee the SIGKILL is
 * actually delivered. (Electron's main process exits on quit regardless of
 * pending timers, so this closes the Node/test case; a quit mid-grace on
 * Electron can still leave the group, which is why the group is killed at all.)
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isAlreadyGone(error)) throw error;
  }
}

/**
 * Best-effort removal of the throwaway work directory. `force` only absorbs
 * ENOENT; an EBUSY/EPERM (Windows, where the npx tree may still be dying) used
 * to escape from a `finally` and REPLACE the real outcome — turning the honest
 * fallback roster into an exception, and masking the original
 * TIMEOUT/CLI_FAILED with a cleanup error. The temp dir living one reboot
 * longer is strictly less harmful than either.
 */
function removeWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[getdesign] failed to remove the temporary work directory ${workDir}:`,
      error,
    );
  }
}

/** Windows never resolves a bare `npx` with `shell: false` — it is `npx.cmd`. */
export const GETDESIGN_WINDOWS_NPX_CANDIDATES = ['npx.cmd', 'npx.exe'] as const;

export interface ResolveNpxCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathString?: string;
  readonly exists?: (candidate: string) => boolean;
}

/**
 * The command to hand to `spawn(..., { shell: false })`.
 *
 * On POSIX `npx` resolves through PATH. On Windows npm ships `npx.cmd` /
 * `npx.exe`, and a bare `npx` with `shell: false` fails with ENOENT — which
 * silently downgraded `listGetDesignBrands` to the static roster and made
 * `getKit` throw SPAWN_FAILED forever (the win32 `taskkill` branch below was
 * unreachable code as a result).
 */
export function resolveNpxCommand(
  options: ResolveNpxCommandOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'npx';
  const pathString = options.pathString ?? process.env.PATH ?? '';
  const exists =
    options.exists ??
    ((candidate: string) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  for (const dir of pathString.split(';')) {
    if (!dir) continue;
    for (const candidate of GETDESIGN_WINDOWS_NPX_CANDIDATES) {
      const full = path.win32.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  // No hit: still name a real Windows executable so the failure is an honest
  // "npx.cmd not found" instead of a bare name that can never resolve.
  return GETDESIGN_WINDOWS_NPX_CANDIDATES[0];
}

/**
 * Kill the whole detached group, not just npx: the package manager's child
 * node process is what actually holds the download open.
 */
async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = path.win32.join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    signalGroup(pid, 'SIGTERM');
  } catch {
    // The SIGKILL escalation below is the authoritative stop.
  }
  await delay(GETDESIGN_TERMINATION_GRACE_MS);
  try {
    signalGroup(pid, 'SIGKILL');
  } catch (error) {
    // Teardown is best-effort: an EPERM here must not become the caller's
    // error (nor an unhandled rejection). The real failure is already framed.
    console.warn(`[getdesign] failed to kill process group ${pid}:`, error);
  }
}

const defaultRunCli: GetDesignCliRunner = (request) =>
  new Promise<GetDesignCliRunResult>((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new GetDesignCliError('ABORTED', 'getdesign run aborted'));
      return;
    }
    const isWindows = process.platform === 'win32';
    const options: SpawnOptions = {
      cwd: request.workDir,
      env: buildNpxChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      shell: false,
      windowsHide: isWindows,
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        resolveNpxCommand(),
        ['-y', GETDESIGN_PACKAGE, ...request.args],
        options,
      );
    } catch (error) {
      reject(
        new GetDesignCliError(
          'SPAWN_FAILED',
          `failed to spawn getdesign: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new GetDesignCliError(
          'TIMEOUT',
          `getdesign timed out after ${GETDESIGN_TIMEOUT_MS}ms`,
        ),
      );
    }, GETDESIGN_TIMEOUT_MS);
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: GetDesignCliError): void {
      if (settled) return;
      settled = true;
      cleanup();
      // `.catch` BEFORE `.finally`: a SIGKILL that answers EPERM would
      // otherwise reject the terminateTree promise, and the `.finally`
      // derivative would carry that rejection out with no handler — an
      // unhandled rejection in the main process, replacing a clean reject.
      void terminateTree(child.pid)
        .catch(() => {})
        .finally(() => reject(error));
    }
    function onAbort(): void {
      fail(new GetDesignCliError('ABORTED', 'getdesign run aborted'));
    }
    function accumulate(chunk: Buffer, isStdout: boolean): void {
      bytes += chunk.length;
      if (bytes > GETDESIGN_MAX_OUTPUT_BYTES) {
        fail(
          new GetDesignCliError(
            'OUTPUT_TOO_LARGE',
            `getdesign output exceeded ${GETDESIGN_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      if (isStdout) stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    }

    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => accumulate(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => accumulate(chunk, false));
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new GetDesignCliError(
          'SPAWN_FAILED',
          `failed to run getdesign: ${error.message}. Ensure Node/npx are available.`,
        ),
      );
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code });
    });
  });

/** Fresh temp directory, always outside the Nexus repo. */
function defaultWorkDirFactory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-getdesign-'));
}

function readDownloadedKit(filePath: string, maxBytes: number): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new GetDesignCliError(
      'NO_OUTPUT',
      'getdesign produced no DESIGN.md output file',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new GetDesignCliError(
      'NO_OUTPUT',
      'getdesign output is not a regular file',
    );
  }
  if (stat.size > maxBytes) {
    throw new GetDesignCliError(
      'OUTPUT_TOO_LARGE',
      `getdesign output exceeded the ${maxBytes}-byte cap`,
    );
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim() === '') {
    throw new GetDesignCliError('NO_OUTPUT', 'getdesign output was empty');
  }
  return content;
}

export async function listGetDesignBrands(
  options: GetDesignSourceOptions = {},
): Promise<GetDesignBrandList> {
  const runCli = options.runCli ?? defaultRunCli;
  const workDirFactory = options.workDirFactory ?? defaultWorkDirFactory;
  let workDir: string | null = null;
  try {
    workDir = workDirFactory();
    const result = await runCli({
      args: ['list'],
      workDir,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const brands = parseGetDesignBrandList(result.stdout);
    if (brands.length > 0) return { brands, isFallback: false };
    return {
      brands: GETDESIGN_FALLBACK_BRANDS,
      isFallback: true,
      detail: 'getdesign list returned no recognizable brand',
    };
  } catch (error) {
    return {
      brands: GETDESIGN_FALLBACK_BRANDS,
      isFallback: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (workDir) removeWorkDir(workDir);
  }
}

export interface GetDesignKitListing {
  readonly kits: readonly DesignKitSummary[];
  readonly isFallback: boolean;
  readonly detail?: string;
}

/**
 * Kit summaries plus the honest provenance of the roster itself: callers must
 * be able to tell "this brand is not in the catalog" from "we could not reach
 * the catalog and are showing the static roster".
 */
export async function listGetDesignKits(
  options: GetDesignSourceOptions = {},
): Promise<GetDesignKitListing> {
  const listed = await listGetDesignBrands(options);
  return {
    kits: listed.brands.map(summaryFor),
    isFallback: listed.isFallback,
    ...(listed.detail === undefined ? {} : { detail: listed.detail }),
  };
}

/**
 * The `getdesign` implementation of `DesignKitSource`. Not always available: it
 * needs npx and network, so callers must be able to fall back to the local
 * catalog.
 */
export function createGetDesignKitSource(
  options: GetDesignSourceOptions = {},
): DesignKitSource {
  const runCli = options.runCli ?? defaultRunCli;
  const workDirFactory = options.workDirFactory ?? defaultWorkDirFactory;
  const maxKitBytes = Math.min(
    options.maxKitBytes ?? GETDESIGN_MAX_KIT_BYTES,
    GETDESIGN_MAX_KIT_BYTES,
  );
  return {
    sourceId: 'getdesign',
    isAlwaysAvailable: false,
    async listKits(): Promise<readonly DesignKitSummary[]> {
      return (await listGetDesignKits(options)).kits;
    },
    async getKit(kitId: string): Promise<DesignKit> {
      const brand = assertValidBrand(kitId);
      const workDir = workDirFactory();
      try {
        const outFile = path.join(workDir, `${brand}.md`);
        const result = await runCli({
          args: ['add', brand, '--out', outFile],
          workDir,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        // `code === null` means the process died from a SIGNAL, not a clean
        // exit. The `--out` file it left behind is a truncated download, and
        // reading it would turn a killed run into a design contract draft.
        // Only exit code 0 is success.
        if (result.code === null) {
          throw new GetDesignCliError(
            'CLI_KILLED',
            `getdesign add ${brand} was killed by a signal before it finished: ` +
              `${result.stderr.trim().slice(0, 512)}`,
          );
        }
        if (result.code !== 0) {
          throw new GetDesignCliError(
            'CLI_FAILED',
            `getdesign add ${brand} exited with code ${result.code}: ` +
              `${result.stderr.trim().slice(0, 512)}`,
          );
        }
        return toDesignKit(
          summaryFor(brand),
          readDownloadedKit(outFile, maxKitBytes),
        );
      } finally {
        removeWorkDir(workDir);
      }
    },
  };
}
