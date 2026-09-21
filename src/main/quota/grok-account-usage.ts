import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountCredentialCandidates } from '../adapters/account-credential-candidates';
import { compareAuthFreshness } from '../adapters/auth-freshness';
import { identityFromAuthBlob } from '../adapters/managed-credentials';
import { fileSubscriptionAuthEnv, getAccount } from '../persistence/account-store';
import { getSecret } from '../persistence/secrets-store';
import { probeGrokCliUsage } from './grok-cli-usage';
import type { LiveProviderProbe } from './provider-live-usage';

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const inFlight = new Map<string | undefined, Promise<LiveProviderProbe>>();

/** One renewal/read-back transaction per account, even across forced snapshots. */
export async function fetchGrokAccountUsage(accountId?: string): Promise<LiveProviderProbe> {
  const existing = inFlight.get(accountId);
  if (existing) return existing;
  const pending = renewAccountUsage(accountId);
  inFlight.set(accountId, pending);
  try { return await pending; } finally { if (inFlight.get(accountId) === pending) inFlight.delete(accountId); }
}

/** Choose the freshest source BEFORE creating another copy of a refresh family. */
async function renewAccountUsage(accountId?: string): Promise<LiveProviderProbe> {
  const unavailable: LiveProviderProbe = { windows: null, hint: 'unavailable' };
  try {
    const nativeFile = path.join(os.homedir(), '.grok', 'auth.json');
    const native = read(nativeFile);
    if (!accountId) return native
      ? probeGrokCliUsage({ authFile: nativeFile, expectedAuthBlob: native })
      : { windows: null, hint: 'no-credential' };
    const account = getAccount(accountId);
    if (account?.adapterId !== 'grok' || account.mode !== 'subscription') return unavailable;
    const saved = getSecret(`acctcred:${accountId}`);
    if (!saved) return { windows: null, hint: 'no-credential' };
    const freshest = accountCredentialCandidates('grok', accountId, saved)[0];
    if (!freshest) return unavailable;
    const subject = identityFromAuthBlob('grok', freshest).subject;
    const useNative = native && subject && identityFromAuthBlob('grok', native).subject === subject &&
      (native === freshest || (compareAuthFreshness(native, freshest) ?? -1) >= 0);
    const authFile = useNative ? nativeFile : (() => {
      const env = fileSubscriptionAuthEnv(account);
      return env?.GROK_HOME ? path.join(env.GROK_HOME, 'auth.json') : null;
    })();
    if (!authFile) return unavailable;
    const anchor = getSecret(`acctcred:${accountId}`);
    const result = await probeGrokCliUsage({ authFile, expectedAuthBlob: freshest });
    // A login/removal while the CLI was running invalidates this observation.
    if (getAccount(accountId) !== account || getSecret(`acctcred:${accountId}`) !== anchor) return unavailable;
    if (result.windows) fileSubscriptionAuthEnv(account);
    return result;
  } catch { return unavailable; }
}
