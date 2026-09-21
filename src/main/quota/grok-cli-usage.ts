import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { identityFromAuthBlob } from '../adapters/managed-credentials';
import { authBlobIsFreshForSpawn, waitForRotatingAuthSpawnGate } from '../adapters/managed-auth-spawn-gate';
import { resolveCliBinary } from '../path-resolver';
import { probeGrokUsageWindows } from './grok-usage';
import type { FetchLike } from './claude-oauth-usage';
import type { LiveProviderProbe } from './provider-live-usage';

const TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const unavailable: LiveProviderProbe = { windows: null, hint: 'unavailable' };
const rpc = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });
const initResult = z.object({ authMethods: z.array(z.object({ id: z.string() })) });
const inflight = new Map<string, Promise<LiveProviderProbe>>();

interface Options {
  authFile: string;
  expectedAuthBlob: string;
  binary?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

function matchingBlob(file: string, subject: string): string | null {
  try {
    const blob = fs.readFileSync(file, 'utf8');
    return identityFromAuthBlob('grok', blob).subject === subject ? blob : null;
  } catch { return null; }
}

function accessToken(blob: string): string | null {
  const record = z.record(z.string(), z.object({ key: z.string().optional(), access_token: z.string().optional() })).safeParse(JSON.parse(blob));
  if (!record.success) return null;
  for (const value of Object.values(record.data)) {
    const token = value.key ?? value.access_token;
    if (token) return token;
  }
  return null;
}

/** Only ACP initialize/authenticate. No session, model turn, browser login, or `grok models`. */
export async function probeGrokCliUsage(options: Options): Promise<LiveProviderProbe> {
  const subject = identityFromAuthBlob('grok', options.expectedAuthBlob).subject;
  if (!subject || path.basename(options.authFile) !== 'auth.json') return unavailable;
  let file: string;
  try { file = fs.realpathSync(options.authFile); } catch { return unavailable; }
  if (!matchingBlob(file, subject)) return unavailable;
  const key = JSON.stringify([file, subject]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = renewAndProbe({ ...options, authFile: file }, subject);
  inflight.set(key, pending);
  try { return await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
}

async function renewAndProbe(options: Options, subject: string): Promise<LiveProviderProbe> {
  try {
    await waitForRotatingAuthSpawnGate({ authFile: options.authFile });
    const before = matchingBlob(options.authFile, subject);
    if (!before) return unavailable;
    if (!authBlobIsFreshForSpawn(before)) {
      const binary = options.binary ?? resolveCliBinary('grok')?.binPath;
      if (!binary) return { windows: null, hint: 'cli-missing' };
      const failure = await authenticateCached(binary, options);
      if (failure) return { windows: null, hint: failure };
    }
    const after = matchingBlob(options.authFile, subject);
    if (!after) return unavailable;
    const token = accessToken(after);
    if (!token) return unavailable;
    const probe = await probeGrokUsageWindows(token, { fetchImpl: options.fetchImpl });
    if (!matchingBlob(options.authFile, subject)) return unavailable;
    return probe.windows ? { windows: probe.windows }
      : { windows: null, hint: probe.authFailed ? 'auth-expired' : 'unavailable' };
  } catch { return unavailable; }
}

type AuthFailure = 'auth-expired' | 'unavailable' | null;
function authenticateCached(binary: string, options: Options): Promise<AuthFailure> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GROK_HOME: path.dirname(options.authFile) };
    delete env.XAI_API_KEY;
    delete env.GROK_API_KEY;
    const child = spawn(binary, ['agent', '--no-leader', 'stdio'], {
      cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let output = '';
    let bytes = 0;
    const finish = (failure: AuthFailure = 'unavailable'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(failure);
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? TIMEOUT_MS);
    const send = (id: number, method: string, params: unknown): void => {
      if (!settled) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };
    const onLine = grokAuthRpcReader(send, finish);
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
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (line.trim()) onLine(line);
      }
    });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  });
}

function grokAuthRpcReader(
  send: (id: number, method: string, params: unknown) => void,
  finish: (failure?: AuthFailure) => void,
): (line: string) => void {
  let expectedId = 1;
  return (line: string): void => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { finish(); return; }
    const parsed = rpc.safeParse(raw);
    if (!parsed.success || parsed.data.id !== expectedId) return;
    if (parsed.data.error !== undefined) {
      const error = z.object({ message: z.string() }).safeParse(parsed.data.error);
      finish(error.success && /invalid_grant|token_revoked|refresh_token_(?:reused|expired|invalidated)/i.test(error.data.message) ? 'auth-expired' : 'unavailable');
      return;
    }
    if (parsed.data.result === undefined) { finish(); return; }
    if (expectedId === 2) { finish(null); return; }
    const init = initResult.safeParse(parsed.data.result);
    if (!init.success) { finish(); return; }
    if (!init.data.authMethods.some(m => m.id === 'cached_token')) { finish('auth-expired'); return; }
    expectedId = 2;
    send(2, 'authenticate', { methodId: 'cached_token', _meta: { headless: true } });
  };
}
