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
