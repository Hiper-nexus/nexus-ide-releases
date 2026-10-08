import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { QuotaWindow } from '../../shared/quota-types';
import { identityFromAuthBlob } from '../adapters/managed-credentials';
import { authBlobIsFreshForSpawn, waitForRotatingAuthSpawnGate } from '../adapters/managed-auth-spawn-gate';
import { CodexRpcError, withCodexAppServer } from '../adapters/codex-app-server-rpc';
import { requestAllCodexModels, type CodexModelListing } from '../adapters/codex-model-list';
import { resolveCliBinary } from '../path-resolver';
import { parseCodexWhamUsage } from './codex-usage';

const CLI_TIMEOUT_MS = 8_000;
/** Folga do `model/list` depois que a cota respondeu (PRV-03). */
const MODEL_LIST_GRACE_MS = 1_500;
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
  /**
   * F-964 (PRV-03): `model/list` do MESMO processo do app-server (um spawn
   * por conta e por ciclo). Ausente = a listagem falhou; a cota não depende dela.
   */
  models?: CodexModelListing;
}

interface CliRpcResult {
  body?: unknown;
  failure?: CodexCliUsageProbe['failure'];
  models?: CodexModelListing;
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
    const models = result.models ? { models: result.models } : {};
    return windows.length ? { windows, ...models } : { ...UNAVAILABLE, ...models };
  } catch {
    // Provider/CLI failures stay unknown. Never log auth or RPC payloads.
    return UNAVAILABLE;
  }
}

const EXPIRED_LOGIN = /\b401\b|token_revoked|refresh_token_(?:reused|expired|invalidated)|invalid_grant/i;

function rpcFailure(error: unknown): CodexCliUsageProbe['failure'] {
  return error instanceof CodexRpcError && error.kind === 'rpc' && EXPIRED_LOGIN.test(error.message)
    ? 'auth-expired'
    : 'unavailable';
}

/**
 * initialize → account/read → (rateLimits/read ∥ model/list) num processo só.
 * A listagem de modelos é enriquecimento: falha dela nunca custa a cota.
 */
async function readCliRateLimits(binary: string, options: CodexCliUsageOptions, refreshToken: boolean): Promise<CliRpcResult> {
  try {
    return await withCodexAppServer(
      { binary, codexHome: path.dirname(options.authFile), timeoutMs: options.timeoutMs ?? CLI_TIMEOUT_MS },
      async (rpc): Promise<CliRpcResult> => {
        const account = await rpc.request('account/read', { refreshToken });
        if (!chatgptAccount.safeParse(account).success) {
          return { failure: expiredAccount.safeParse(account).success ? 'auth-expired' : 'unavailable' };
        }
        const body = rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true });
        const listing = requestAllCodexModels(rpc).catch(() => undefined);
        const usage = await body;
        // A cota já chegou: a listagem ganha só uma folga curta, nunca o prazo todo.
        let grace: ReturnType<typeof setTimeout> | undefined;
        const models = await Promise.race([
          listing,
          new Promise<undefined>((resolve) => { grace = setTimeout(() => resolve(undefined), MODEL_LIST_GRACE_MS); }),
        ]).finally(() => clearTimeout(grace));
        return { body: usage, ...(models ? { models } : {}) };
      },
    );
  } catch (error) {
    return { failure: rpcFailure(error) };
  }
}
