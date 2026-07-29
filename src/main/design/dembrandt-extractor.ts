import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBrowserUrl,
  type BrowserUrlDecision,
} from '../browser/url-policy';

/**
 * Governed Dembrandt CLI wrapper.
 *
 * Extracts a live site's design system into DESIGN.md markdown. Callers must
 * feed the result into ContextDraft propose() — never write DESIGN.md at the
 * workspace root from this module.
 *
 * Security notes:
 * - URL policy blocks private/forbidden networks before spawn.
 * - Child env is an allowlist (no process.env passthrough of secrets).
 * - Chromium runs with its default sandbox (no --no-sandbox).
 * - Playwright may still follow redirects after the initial DNS check; treat
 *   extracted content as untrusted until draft review.
 */

export const DEMBRANDT_PACKAGE = 'dembrandt@0.25.1';
export const DEMBRANDT_TIMEOUT_MS = 120_000;
export const DEMBRANDT_MAX_OUTPUT_BYTES = 2_000_000;

/** Env keys forwarded to the Dembrandt child (everything else is dropped). */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NODE_OPTIONS',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_registry',
  'npm_config_user_agent',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
] as const;

export class DembrandtExtractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DembrandtExtractError';
    this.code = code;
  }
}

export interface DembrandtExtractInput {
  readonly url: string;
  readonly paths?: readonly string[];
  readonly darkMode?: boolean;
  readonly mobile?: boolean;
  readonly wcag?: boolean;
  readonly signal?: AbortSignal;
  /** Injectable for tests. Defaults to assessBrowserUrl without private net. */
  readonly assessUrl?: (
    raw: string,
  ) => Promise<BrowserUrlDecision>;
  /** Injectable CLI runner for tests. */
  readonly runner?: DembrandtCliRunner;
}

export interface DembrandtExtractResult {
  readonly designMd: string;
  readonly sourceUrl: string;
  readonly normalizedUrl: string;
}

export interface DembrandtCliRunRequest {
  readonly normalizedUrl: string;
  readonly paths: readonly string[];
  readonly darkMode: boolean;
  readonly mobile: boolean;
  readonly wcag: boolean;
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

export type DembrandtCliRunner = (
  request: DembrandtCliRunRequest,
) => Promise<{ designMd: string }>;

function defaultAssessUrl(raw: string): Promise<BrowserUrlDecision> {
  return assessBrowserUrl(raw, { allowPrivateNetwork: false });
}

export function buildDembrandtChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { npm_config_yes: 'true' };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function buildCliArgs(request: DembrandtCliRunRequest): string[] {
  const args = [
    '-y',
    DEMBRANDT_PACKAGE,
    request.normalizedUrl,
    '--design-md',
  ];
  for (const pagePath of request.paths) {
    const trimmed = pagePath.trim();
    if (!trimmed) continue;
    args.push(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
  }
  if (request.darkMode) args.push('--dark-mode');
  if (request.mobile) args.push('--mobile');
  if (request.wcag) args.push('--wcag');
  return args;
}

function findDesignMd(workDir: string): string | null {
  const outputRoot = path.join(workDir, 'output');
  if (!fs.existsSync(outputRoot)) return null;
  const stack = [outputRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === 'design.md') {
        return full;
      }
    }
  }
  return null;
}

export async function defaultDembrandtCliRunner(
  request: DembrandtCliRunRequest,
): Promise<{ designMd: string }> {
  const args = buildCliArgs(request);
  const env = buildDembrandtChildEnv();

  return await new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: request.workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        new DembrandtExtractError(
          'TIMEOUT',
          `dembrandt timed out after ${DEMBRANDT_TIMEOUT_MS}ms`,
        ),
      );
    }, DEMBRANDT_TIMEOUT_MS);

    const onAbort = () => {
      fail(new DembrandtExtractError('ABORTED', 'dembrandt extraction aborted'));
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const accumulate = (chunk: Buffer, target: 'out' | 'err') => {
      totalBytes += chunk.length;
      if (totalBytes > DEMBRANDT_MAX_OUTPUT_BYTES) {
        fail(
          new DembrandtExtractError(
            'OUTPUT_TOO_LARGE',
            `dembrandt output exceeded ${DEMBRANDT_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      const text = chunk.toString('utf8');
      if (target === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => accumulate(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => accumulate(chunk, 'err'));

    child.on('error', (error) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      fail(
        new DembrandtExtractError(
          'SPAWN_FAILED',
          `failed to spawn dembrandt: ${error.message}. Ensure Node/npx are available; browser binary may need \`npx dembrandt@0.25.1 install-browser\`.`,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 800);
        const browserHint =
          /Executable doesn't exist|browser|chromium|playwright/i.test(detail)
            ? ' Run `npx dembrandt@0.25.1 install-browser` once, then retry.'
            : '';
        reject(
          new DembrandtExtractError(
            'EXTRACTION_FAILED',
            `dembrandt exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}.${browserHint}`,
          ),
        );
        return;
      }

      const designPath = findDesignMd(request.workDir);
      if (!designPath) {
        reject(
          new DembrandtExtractError(
            'NO_DESIGN_MD',
            'dembrandt completed but DESIGN.md was not found under output/',
          ),
        );
        return;
      }
      let designMd: string;
      try {
        designMd = fs.readFileSync(designPath, 'utf8');
      } catch (error) {
        reject(
          new DembrandtExtractError(
            'READ_FAILED',
            `failed to read DESIGN.md: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (!designMd.trim()) {
        reject(
          new DembrandtExtractError(
            'EMPTY_DESIGN_MD',
            'dembrandt produced an empty DESIGN.md',
          ),
        );
        return;
      }
      if (Buffer.byteLength(designMd, 'utf8') > DEMBRANDT_MAX_OUTPUT_BYTES) {
        reject(
          new DembrandtExtractError(
            'OUTPUT_TOO_LARGE',
            `DESIGN.md exceeded ${DEMBRANDT_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      resolve({ designMd });
    });
  });
}

/**
 * Assess URL policy, run Dembrandt in an isolated temp cwd, return DESIGN.md.
 */
export async function extractDesignSystemFromUrl(
  input: DembrandtExtractInput,
): Promise<DembrandtExtractResult> {
  const assess = input.assessUrl ?? defaultAssessUrl;
  const decision = await assess(input.url);
  if (!decision.allowed) {
    const kind = decision.kind;
    if (kind === 'private-network' || kind === 'forbidden-network') {
      throw new DembrandtExtractError(
        'URL_BLOCKED',
        `dembrandt extraction blocked (${kind}): ${decision.reason}`,
      );
    }
    throw new DembrandtExtractError(
      'URL_INVALID',
      `dembrandt extraction blocked (${kind}): ${decision.reason}`,
    );
  }

  // Defense in depth: refuse literal private/forbidden address classes that
  // somehow passed a custom assessUrl injection.
  if (
    decision.addressClasses?.some(
      (cls) =>
        cls === 'loopback' ||
        cls === 'private' ||
        cls === 'link-local' ||
        cls === 'metadata' ||
        cls === 'carrier-grade-nat',
    )
  ) {
    throw new DembrandtExtractError(
      'URL_BLOCKED',
      'dembrandt extraction blocked: resolved address is not public',
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dembrandt-'));
  try {
    const runner = input.runner ?? defaultDembrandtCliRunner;
    const { designMd } = await runner({
      normalizedUrl: decision.normalizedUrl,
      paths: input.paths ?? [],
      darkMode: input.darkMode === true,
      mobile: input.mobile === true,
      wcag: input.wcag === true,
      workDir,
      signal: input.signal,
    });
    return {
      designMd,
      sourceUrl: input.url.trim(),
      normalizedUrl: decision.normalizedUrl,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** @internal exported for unit tests */
export const __test = {
  buildCliArgs,
  findDesignMd,
  buildDembrandtChildEnv,
  CHILD_ENV_ALLOWLIST,
};
