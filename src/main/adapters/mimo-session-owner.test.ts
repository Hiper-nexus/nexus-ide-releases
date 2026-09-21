import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ owner: '' }));
vi.mock('../persistence/provider-session-store', () => ({ providerSessionAccountIsCompatible: (_scope: unknown, _adapter: string, _session: string, _account: unknown, owner: string) => owner === deps.owner }));
import { canResumeMimoNativeSession, currentMimoSessionOwnerKey, mimoSessionOwnerKey } from './mimo-session-owner';
let root = '';
afterEach(() => { vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('denies native A to B resume while preserving identity across same-UID key renewal', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-native-owner-'));
  vi.stubEnv('MIMOCODE_HOME', root); fs.mkdirSync(path.join(root, 'data'));
  const write = (uid: string, key: string, region = 'sgp') => fs.writeFileSync(path.join(root, 'data', 'auth.json'), JSON.stringify({ xiaomi: {
    type: 'api', key, metadata: { uid, base_url: `https://token-plan-${region}.xiaomimimo.com/v1` },
  } }));
  const scope = {} as Parameters<typeof canResumeMimoNativeSession>[0];
  write('a', 'key-a'); deps.owner = currentMimoSessionOwnerKey()!;
  expect(canResumeMimoNativeSession(scope, 'old-root')).toBe(true);
  write('a', 'renewed-key-a'); expect(canResumeMimoNativeSession(scope, 'old-root')).toBe(true);
  write('b', 'key-b'); expect(canResumeMimoNativeSession(scope, 'old-root')).toBe(false);
  write('a', 'key-a', 'cn'); expect(canResumeMimoNativeSession(scope, 'old-root')).toBe(false);
  expect(canResumeMimoNativeSession(scope, 'old-root', 'selected-api-key')).toBe(false);
  expect(mimoSessionOwnerKey({ key: 'selected-api-key', baseUrl: 'https://api.xiaomimimo.com/v1' })).not.toContain('selected-api-key');
});
