import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resetGrokAuthFamiliesForTests, withGrokAuthFamilyGate } from './grok-auth-family-gate';
const roots: string[] = [];
afterEach(() => { resetGrokAuthFamiliesForTests(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it('never replaces a follower file switched to another account while waiting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-family-')); roots.push(root);
  const native = path.join(root, 'native.json'), managed = path.join(root, 'managed.json');
  const blob = (user: string) => JSON.stringify({ issuer: { user_id: user, refresh_token: 'same-refresh', key: 'fixture-token' } });
  fs.writeFileSync(native, blob('a')); fs.writeFileSync(managed, blob('a'));
  await withGrokAuthFamilyGate(native, async () => 'leader');
  await expect(withGrokAuthFamilyGate(managed, async () => { fs.writeFileSync(managed, blob('b')); return 'follower-fresh'; })).rejects.toThrow('conta mudou');
  expect(fs.readFileSync(managed, 'utf8')).toBe(blob('b'));
});
it.each(['same-subject-expired', 'different-team'])('rejects an unrelated rewrite during renewal: %s', async (change) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-family-')); roots.push(root);
  const native = path.join(root, 'native.json'), managed = path.join(root, 'managed.json');
  const blob = (team: string, refresh: string, expires: number) => JSON.stringify({ issuer: {
    user_id: 'a', team_id: team, refresh_token: refresh, key: 'fixture-token', expires_at: new Date(expires).toISOString(),
  } });
  const before = blob('team-a', 'old-refresh', Date.now() - 3600000);
  fs.writeFileSync(native, before); fs.writeFileSync(managed, before);
  await withGrokAuthFamilyGate(native, async () => 'leader');
  await expect(withGrokAuthFamilyGate(managed, async () => {
    fs.writeFileSync(native, blob(change === 'different-team' ? 'team-b' : 'team-a', 'new-refresh', Date.now() + 3600000));
    if (change === 'same-subject-expired') fs.writeFileSync(managed, blob('team-a', 'other-expired-refresh', Date.now() - 1800000));
    return 'follower-fresh';
  })).rejects.toThrow(/mudou/);
});

// Codex também entra neste portão: o subject é o `user_id` do id_token. Blobs
// sintéticos com a forma real do ~/.codex/auth.json.
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.s`;
const codex = (account: string, refresh: string, issuedAt: string) => JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email: 'a@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: account, user_id: 'user-a' } }),
    access_token: jwt({ exp: 1 }),
    refresh_token: refresh,
    account_id: account,
  },
  last_refresh: issuedAt,
});
const refreshOf = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: { refresh_token: string } }).tokens.refresh_token;

it('Codex: a cópia velha não lidera a renovação quando a irmã já girou o refresh token no meio da sessão', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-family-')); roots.push(root);
  const native = path.join(root, 'native.json'), managed = path.join(root, 'managed.json');
  fs.writeFileSync(native, codex('acct-a', 'rt-0', '2026-10-01T00:00:00Z'));
  fs.writeFileSync(managed, codex('acct-a', 'rt-0', '2026-10-01T00:00:00Z'));
  await withGrokAuthFamilyGate(native, async () => 'fresh'); // a descoberta de modelos registrou o nativo primeiro
  await withGrokAuthFamilyGate(managed, async () => 'fresh'); // o pane da conta entrou na família
  fs.writeFileSync(managed, codex('acct-a', 'rt-1', '2026-10-02T00:00:00Z')); // e renovou no meio da sessão
  let renewedWith = '';
  await withGrokAuthFamilyGate(native, async (file) => { renewedWith = refreshOf(file); return 'leader'; });
  // A CLI do nativo renova com o token vivo, não com o `rt-0` já consumido.
  expect(renewedWith).toBe('rt-1');
  expect(refreshOf(native)).toBe('rt-1');
});

it('Codex: o mesmo usuário em outro workspace nunca é copiado para a conta', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-family-')); roots.push(root);
  const native = path.join(root, 'native.json'), managed = path.join(root, 'managed.json');
  fs.writeFileSync(native, codex('acct-a', 'rt-0', '2026-10-01T00:00:00Z'));
  fs.writeFileSync(managed, codex('acct-a', 'rt-0', '2026-10-01T00:00:00Z'));
  await withGrokAuthFamilyGate(native, async () => 'fresh');
  // O operador entrou, no nativo, em outro workspace do mesmo usuário ChatGPT.
  fs.writeFileSync(native, codex('acct-b', 'rt-b', '2026-10-02T00:00:00Z'));
  let ranOn = '';
  const role = await withGrokAuthFamilyGate(managed, async (file) => { ranOn = refreshOf(file); return 'fresh'; });
  expect(role).toBe('fresh');
  expect(ranOn).toBe('rt-0');
  expect(JSON.parse(fs.readFileSync(managed, 'utf8')).tokens.account_id).toBe('acct-a');
});
