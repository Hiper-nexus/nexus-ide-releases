import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ account: vi.fn(), secret: vi.fn(), candidates: vi.fn(), env: vi.fn(), probe: vi.fn() }));
vi.mock('../persistence/account-store', () => ({ getAccount: mocks.account, fileSubscriptionAuthEnv: mocks.env }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: mocks.secret }));
vi.mock('../adapters/account-credential-candidates', () => ({ accountCredentialCandidates: mocks.candidates }));
vi.mock('./grok-cli-usage', () => ({ probeGrokCliUsage: mocks.probe }));
import { fetchGrokAccountUsage } from './grok-account-usage';

let home: string;
let nativeFile: string;
let managedHome: string;
const blob = (subject: string, issued: number) => JSON.stringify({ issuer: { user_id: subject, key: 'fixture-token', create_time: new Date(issued).toISOString() } });
const account = { id: 'account-a', adapterId: 'grok', mode: 'subscription' };
const now = Date.now();
beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sources-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  nativeFile = path.join(home, '.grok', 'auth.json');
  managedHome = path.join(home, 'managed');
  fs.mkdirSync(path.dirname(nativeFile)); fs.mkdirSync(managedHome);
  mocks.account.mockReturnValue(account);
  mocks.secret.mockReturnValue(blob('a', now));
  mocks.candidates.mockReturnValue([blob('a', now)]);
  mocks.env.mockReturnValue({ GROK_HOME: managedHome });
  mocks.probe.mockImplementation(async ({ authFile }) => ({ windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: authFile === nativeFile ? 0.06 : 0.8, source: 'provider-api', confidence: 'high' }] }));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
it('renews the canonical native session when it is the freshest matching identity', async () => {
  fs.writeFileSync(nativeFile, blob('a', now + 1000));
  expect((await fetchGrokAccountUsage('account-a')).windows?.[0].usedRatio).toBe(0.06);
  // Managed convergence must happen only after canonical renewal, not before.
  expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.env.mock.invocationCallOrder[0]);
});
it('never borrows or rewrites another native account', async () => {
  const foreign = blob('b', now + 1000); fs.writeFileSync(nativeFile, foreign);
  expect((await fetchGrokAccountUsage('account-a')).windows?.[0].usedRatio).toBe(0.8);
  expect(fs.readFileSync(nativeFile, 'utf8')).toBe(foreign);
});
it('does not retry an older native refresh family when managed auth is newer', async () => {
  fs.writeFileSync(nativeFile, blob('a', now - 1000));
  expect((await fetchGrokAccountUsage('account-a')).windows?.[0].usedRatio).toBe(0.8);
});
it('drops an observation if the user replaces the selected account during renewal', async () => {
  fs.writeFileSync(nativeFile, blob('a', now));
  mocks.probe.mockImplementation(async () => { mocks.account.mockReturnValue({ ...account }); return { windows: [{ usedRatio: 0.06 }] }; });
  expect((await fetchGrokAccountUsage('account-a')).windows).toBeNull();
});
it('does not renew a different provider or an API-key account', async () => {
  mocks.account.mockReturnValue({ ...account, mode: 'api-key' });
  expect((await fetchGrokAccountUsage('account-a')).windows).toBeNull();
  expect(mocks.probe).not.toHaveBeenCalled();
});
it('shares renewal and vault convergence across overlapping refreshes of the same account', async () => {
  fs.writeFileSync(nativeFile, blob('a', now));
  mocks.env.mockImplementation(() => { mocks.secret.mockReturnValue(blob('a', now + 1000)); return { GROK_HOME: managedHome }; });
  const results = await Promise.all([fetchGrokAccountUsage('account-a'), fetchGrokAccountUsage('account-a')]);
  expect(results.map(r => r.windows?.[0].usedRatio)).toEqual([0.06, 0.06]);
});
