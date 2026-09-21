import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accountCredentialCandidates } from './account-credential-candidates';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-candidates-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

function auth(subject: string, day: number): string {
  return JSON.stringify({ tokens: { account_id: subject, access_token: `access-${subject}-${day}` }, last_refresh: `2026-09-${day}T00:00:00Z` });
}
function write(relative: string, blob: string): string {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, blob);
  return file;
}

it('keeps the newer vault first and never writes a native or managed credential', () => {
  const native = write('.codex/auth.json', auth('a', 10));
  const managed = write('.nexus/managed-accounts/codex/acct-a/home/auth.json', auth('a', 11));
  const vault = auth('a', 21);
  expect(accountCredentialCandidates('codex', 'acct-a', vault)[0]).toBe(vault);
  expect(fs.readFileSync(native, 'utf8')).toBe(auth('a', 10));
  expect(fs.readFileSync(managed, 'utf8')).toBe(auth('a', 11));
});

it('rejects a newer managed credential belonging to another workspace', () => {
  write('.nexus/managed-accounts/codex/acct-a/home/auth.json', auth('b', 21));
  expect(accountCredentialCandidates('codex', 'acct-a', auth('a', 10))).toEqual([auth('a', 10)]);
});

it('does not infer native identity from an email substring in unrelated metadata', () => {
  write('.codex/auth.json', JSON.stringify({ ...JSON.parse(auth('b', 21)), note: 'owner@example.test' }));
  expect(accountCredentialCandidates('codex', 'acct-a', null)).toEqual([]);
});

it('does not adopt a fresher managed credential whose identity is unknown', () => {
  write('.nexus/managed-accounts/codex/acct-a/home/auth.json', JSON.stringify({ tokens: { access_token: 'unknown-owner' }, last_refresh: '2026-09-21T00:00:00Z' }));
  expect(accountCredentialCandidates('codex', 'acct-a', auth('a', 10))).toEqual([auth('a', 10)]);
});

it('does not borrow a native workspace based only on an email when the saved credential is missing', () => {
  write('.codex/auth.json', JSON.stringify({ ...JSON.parse(auth('b', 21)), email: 'owner@example.test' }));
  expect(accountCredentialCandidates('codex', 'acct-a', null)).toEqual([]);
});

it('requires the known workspace subject even when a native credential has the same email', () => {
  const vault = JSON.stringify({ ...JSON.parse(auth('a', 10)), email: 'owner@example.test' });
  write('.codex/auth.json', JSON.stringify({ email: 'owner@example.test', tokens: { access_token: 'unscoped' }, last_refresh: '2026-09-21T00:00:00Z' }));
  expect(accountCredentialCandidates('codex', 'acct-a', vault)).toEqual([vault]);
});

it('ignores a newer native logout shell instead of erasing the saved login', () => {
  write('.codex/auth.json', JSON.stringify({ tokens: { account_id: 'a' }, last_refresh: '2026-09-21T00:00:00Z' }));
  expect(accountCredentialCandidates('codex', 'acct-a', auth('a', 10))).toEqual([auth('a', 10)]);
});
