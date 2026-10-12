/**
 * OpenClaude subscription quota probe (Claude Code fork).
 *
 * Same credential blob shape as Claude (`claudeAiOauth.accessToken` in
 * `~/.openclaude/.credentials.json` or the OpenClaude Keychain service).
 * When the token is a real Anthropic OAuth grant the authoritative
 * `api.anthropic.com/api/oauth/usage` works unchanged. Fallback is the
 * print-only `openclaude /usage` (same TUI lines as `claude /usage`).
 *
 * Never invents percentages: any failure returns null windows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  extractClaudeAccessToken,
  parseClaudeCliUsage,
  probeClaudeOauthUsage,
  claudeCliOutputIsAuthFailure,
  type ClaudeCliUsageProbe,
  type ClaudeCliRunImpl,
  type ClaudeCliRunResult,
  type FetchLike,
} from './claude-oauth-usage';
import { resolveCliBinary } from '../path-resolver';
import {
  openClaudeKeychainService,
  readNativeOAuthCredential,
} from '../adapters/native-oauth-keychain';

export const OPENCLAUDE_CLI_USAGE_TIMEOUT_MS = 20_000;

/** Same print-only shape as `claude /usage` — no session, no hooks, no MCP. */
export const OPENCLAUDE_CLI_USAGE_ARGS = [
  '--print',
  '--no-session-persistence',
  '--strict-mcp-config',
  '/usage',
] as const;

export function openclaudeConfigDir(home = os.homedir()): string {
  const override = process.env.OPENCLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return path.join(home, '.openclaude');
}

function readCredentialsFile(home = os.homedir()): string | null {
  try {
    const raw = fs.readFileSync(
      path.join(openclaudeConfigDir(home), '.credentials.json'),
      'utf8',
    );
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Native OpenClaude OAuth access token. File first (CLI-owned refresh —
 * quota only reads); Keychain on macOS when the file is gone. Never rotates.
 */
export async function resolveOpenClaudeToken(
  home = os.homedir(),
): Promise<string | null> {
  const blob = readCredentialsFile(home);
  const fileToken = blob ? extractClaudeAccessToken(blob) : null;
  if (fileToken || process.platform !== 'darwin') return fileToken;
  try {
    const native = await readNativeOAuthCredential(
      openClaudeKeychainService(home, process.env.OPENCLAUDE_CONFIG_DIR),
    );
    return native ? extractClaudeAccessToken(native) : null;
  } catch {
    return null;
  }
}

/** Public session evidence without touching the secret. */
export function openclaudeSignedIn(home = os.homedir()): boolean {
  if (readCredentialsFile(home)) return true;
  // Keychain presence is async; the sync path only proves the file seat.
  return false;
}

async function runOpenClaudeCli(
  binary: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ClaudeCliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
        PWD: cwd,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, OPENCLAUDE_CLI_USAGE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function locateOpenClaudeBinary(): string | null {
  const resolved = resolveCliBinary('openclaude')?.binPath ?? null;
  if (!resolved) return null;
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    // .cmd on Windows is not X_OK; still hand it to the runner.
    return resolved;
  }
}

/**
 * `openclaude /usage` print-only. Same line grammar as Claude Code.
 */
export async function probeOpenClaudeCliUsage(opts?: {
  runImpl?: ClaudeCliRunImpl;
  now?: number;
  cwd?: string;
  home?: string;
}): Promise<ClaudeCliUsageProbe> {
  const run = opts?.runImpl ?? runOpenClaudeCli;
  const cwd =
    opts?.cwd ?? path.join(os.tmpdir(), 'nexus-ide-openclaude-usage');
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    // cwd fixo é defesa, não requisito
  }
  const binary = locateOpenClaudeBinary();
  if (!binary) return { windows: null, failure: 'cli-missing' };

  const configDir = openclaudeConfigDir(opts?.home ?? os.homedir());
  const env: Record<string, string> = {
    OPENCLAUDE_CONFIG_DIR: configDir,
  };

  const { code, stdout, stderr } = await run(
    binary,
    OPENCLAUDE_CLI_USAGE_ARGS,
    cwd,
    env,
  );
  if (
    claudeCliOutputIsAuthFailure(stdout) ||
    claudeCliOutputIsAuthFailure(stderr ?? '')
  ) {
    return { windows: null, failure: 'auth-expired' };
  }
  if (code !== 0 || !stdout.trim()) {
    return { windows: null, failure: 'unavailable' };
  }
  const windows = parseClaudeCliUsage(stdout, opts?.now ?? Date.now());
  return windows.length > 0
    ? { windows }
    : { windows: null, failure: 'unavailable' };
}

/**
 * OAuth usage first (authoritative when the grant is Anthropic), then the
 * CLI `/usage` fallback for 429/keychain/file drift. Saved-account rows
 * pass `accountId` and only read that account's secret — never the machine
 * login.
 */
export async function probeOpenClaudeUsage(opts?: {
  fetchImpl?: FetchLike;
  now?: number;
  accountId?: string;
  token?: string | null;
  cliProbe?: () => Promise<ClaudeCliUsageProbe>;
  home?: string;
}): Promise<ClaudeCliUsageProbe> {
  const token =
    opts?.token !== undefined
      ? opts.token
      : await resolveOpenClaudeToken(opts?.home ?? os.homedir());
  if (token) {
    const oauth = await probeClaudeOauthUsage(token, {
      fetchImpl: opts?.fetchImpl,
      now: opts?.now,
    });
    if (oauth.windows?.length) return { windows: oauth.windows };
    if (oauth.failure === 'auth-expired') {
      // Grant dead server-side: CLI may still refresh from its own store.
      const cli = opts?.cliProbe
        ? await opts.cliProbe()
        : await probeOpenClaudeCliUsage({ now: opts?.now, home: opts?.home });
      if (cli.windows?.length) return cli;
      return { windows: null, failure: 'auth-expired' };
    }
  }
  const cli = opts?.cliProbe
    ? await opts.cliProbe()
    : await probeOpenClaudeCliUsage({ now: opts?.now, home: opts?.home });
  return cli;
}
