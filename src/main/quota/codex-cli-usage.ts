import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { QuotaWindow } from '../../shared/quota-types';
import { identityFromAuthBlob } from '../adapters/managed-credentials';
import { authBlobIsFreshForSpawn, waitForRotatingAuthSpawnGate } from '../adapters/managed-auth-spawn-gate';
import { resolveCliBinary } from '../path-resolver';
import { parseCodexWhamUsage } from './codex-usage';

const CLI_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const rateWindow = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().finite().nullable().optional(),
  resetsAt: z.number().finite().nullable().optional(),
});
const rateLimits = z.object({
  accountId: z.string().nullable().optional(),
  rateLimits: z.object({
    primary: rateWindow.nullable().optional(),
    secondary: rateWindow.nullable().optional(),
  }),
});
const rpcResponse = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });
const chatgptAccount = z.object({ account: z.object({ type: z.literal('chatgpt') }) });
const expiredAccount = z.object({ account: z.null(), requiresOpenaiAuth: z.literal(true) });

export function parseCodexCliRateLimits(body: unknown, now = Date.now()): QuotaWindow[] {
  const parsed = rateLimits.safeParse(body);
  if (!parsed.success) return [];
  const map = (window: z.infer<typeof rateWindow> | null | undefined) => window ? {
    used_percent: window.usedPercent,
    limit_window_seconds: window.windowDurationMins == null ? undefined : window.windowDurationMins * 60,
    reset_at: window.resetsAt ?? undefined,
  } : null;
  return parseCodexWhamUsage({ rate_limit: {
    primary_window: map(parsed.data.rateLimits.primary),
    secondary_window: map(parsed.data.rateLimits.secondary),
  } }, now);
}

function matchingAuth(authFile: string, subject: string): string | null {
  try {
    const blob = fs.readFileSync(authFile, 'utf8');
    return identityFromAuthBlob('codex', blob).subject === subject ? blob : null;
  } catch {
    return null;
  }
}

interface CodexCliUsageOptions {
  /** The durable managed auth.json used by panes of this account. */
  authFile: string;
  /** Saved account anchor; a missing stable account subject fails closed. */
  expectedAuthBlob: string;
  binary?: string;
  now?: number;
  timeoutMs?: number;
}

export interface CodexCliUsageProbe {
  windows: QuotaWindow[] | null;
  failure?: 'auth-expired' | 'unavailable' | 'cli-missing';
}

interface CliRpcResult {
  body?: unknown;
  failure?: CodexCliUsageProbe['failure'];
}

const UNAVAILABLE: CodexCliUsageProbe = { windows: null, failure: 'unavailable' };

/** No thread or model invocation. Only Codex itself may renew its saved login. */
export async function fetchCodexCliUsage(options: CodexCliUsageOptions): Promise<QuotaWindow[] | null> {
  return (await probeCodexCliUsage(options)).windows;
}

export async function probeCodexCliUsage(options: CodexCliUsageOptions): Promise<CodexCliUsageProbe> {
  const subject = identityFromAuthBlob('codex', options.expectedAuthBlob).subject;
  if (!subject || path.basename(options.authFile) !== 'auth.json') return UNAVAILABLE;
  if (!matchingAuth(options.authFile, subject)) return UNAVAILABLE;
  try {
    const binary = options.binary ?? resolveCliBinary('codex')?.binPath;
    if (!binary) return { windows: null, failure: 'cli-missing' };
    await waitForRotatingAuthSpawnGate({ authFile: options.authFile });
    const current = matchingAuth(options.authFile, subject);
    if (!current) return UNAVAILABLE;
    const now = options.now ?? Date.now();
    const result = await readCliRateLimits(binary, options, !authBlobIsFreshForSpawn(current, now));
    if (!matchingAuth(options.authFile, subject)) return UNAVAILABLE;
    if (result.failure) return { windows: null, failure: result.failure };
    const parsed = rateLimits.safeParse(result.body);
    if (!parsed.success || (parsed.data.accountId && parsed.data.accountId !== subject)) return UNAVAILABLE;
    const windows = parseCodexCliRateLimits(parsed.data, now);
    return windows.length ? { windows } : UNAVAILABLE;
  } catch {
    // Provider/CLI failures stay unknown. Never log auth or RPC payloads.
    return UNAVAILABLE;
  }
}

function accountRpcReader(
  send: (method: string, params?: unknown, id?: number) => void,
  finish: (value?: CliRpcResult) => void,
  refreshToken: boolean,
): (line: string) => void {
  let expectedId = 1;
  return (line) => {
    let data: unknown;
    try { data = JSON.parse(line); } catch { finish(); return; }
    const parsed = rpcResponse.safeParse(data);
    if (!parsed.success || parsed.data.id !== expectedId) return;
    if (parsed.data.error !== undefined) {
      const error = z.object({ message: z.string() }).safeParse(parsed.data.error);
      const expired = error.success && /\b401\b|token_revoked|refresh_token_(?:reused|expired|invalidated)|invalid_grant/i.test(error.data.message);
      finish({ failure: expired ? 'auth-expired' : 'unavailable' });
      return;
    }
    if (expectedId === 3) { finish({ body: parsed.data.result }); return; }
    if (expectedId === 1) {
      expectedId = 2;
      send('initialized');
      send('account/read', { refreshToken }, expectedId);
      return;
    }
    if (!chatgptAccount.safeParse(parsed.data.result).success) {
      finish({ failure: expiredAccount.safeParse(parsed.data.result).success ? 'auth-expired' : 'unavailable' });
      return;
    }
    expectedId = 3;
    send('account/rateLimits/read', { excludeResetCreditDetails: true }, expectedId);
  };
}

function readCliRateLimits(binary: string, options: CodexCliUsageOptions, refreshToken: boolean): Promise<CliRpcResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.dirname(options.authFile) };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const child = spawn(binary, ['app-server', '-c', 'cli_auth_credentials_store="file"',
      '-c', 'analytics.enabled=false', '-c', 'otel.exporter="none"'], {
      cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let output = '';
    let bytes = 0;
    const finish = (value: CliRpcResult = { failure: 'unavailable' }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? CLI_TIMEOUT_MS);
    const send = (method: string, params?: unknown, id?: number): void => {
      if (settled) return;
      child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }), ...(id ? { id } : {}) })}\n`);
    };
    const onLine = accountRpcReader(send, finish, refreshToken);
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { finish(); return; }
      output += chunk.toString('utf8');
      let newline: number;
      while (!settled && (newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (line.trim()) onLine(line);
      }
    });
    send('initialize', { clientInfo: { name: 'nexus_quota', version: '1.0' }, capabilities: null }, 1);
  });
}
