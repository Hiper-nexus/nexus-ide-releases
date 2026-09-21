import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureNativeAuth, identityFromAuthBlob, managedHomeEnv, materializeManagedHome, readBackFresherAuth } from './managed-credentials';
const roots: string[] = [];
const blob = (uid: string, key: string) => JSON.stringify({ xiaomi: { type: 'api', key, metadata: { uid } } });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it('saves only Xiaomi auth and isolates two managed accounts without copying conversation data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mimo-accounts-')); roots.push(home);
  const native = path.join(home, '.local/share/mimocode'); fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'auth.json'), JSON.stringify({ ...JSON.parse(blob('a','key-a')), openai: { access: 'foreign-credential' } }));
  fs.writeFileSync(path.join(native, 'mimocode.db'), 'native conversation');
  const captured = captureNativeAuth('mimo-code', home)!;
  expect(captured.authRelativePath).toBe(path.join('data', 'auth.json'));
  expect(captured.blob).not.toContain('foreign-credential');
  expect(identityFromAuthBlob('mimo-code', captured.blob).subject).toBeDefined();
  const a = materializeManagedHome('mimo-code','account-a',captured.blob,{home});
  const b = materializeManagedHome('mimo-code','account-b',blob('b','key-b'),{home});
  expect(managedHomeEnv('mimo-code',a)).toEqual({ MIMOCODE_HOME:a });
  expect(fs.readFileSync(path.join(a,'data/auth.json'),'utf8')).toContain('key-a');
  expect(fs.readFileSync(path.join(b,'data/auth.json'),'utf8')).toContain('key-b');
  expect(fs.existsSync(path.join(a,'data/mimocode.db'))).toBe(false);
  const renewed = blob('a','new-key-a');
  materializeManagedHome('mimo-code','account-a',renewed,{home});
  expect(fs.readFileSync(path.join(a,'data/auth.json'),'utf8')).toBe(renewed);
  expect(readBackFresherAuth('mimo-code','account-a',renewed,{home})).toBeNull();
});

it('keeps API and regional Token Plan profiles for the same Xiaomi user distinct', () => {
  const profile = (baseUrl: string) => JSON.stringify({ xiaomi: {
    type: 'api', key: 'fixture', metadata: { uid: 'same-user', base_url: baseUrl },
  } });
  const api = identityFromAuthBlob('mimo-code', profile('https://api.xiaomimimo.com/v1'));
  const sgp = identityFromAuthBlob('mimo-code', profile('https://token-plan-sgp.xiaomimimo.com/v1'));
  const ams = identityFromAuthBlob('mimo-code', profile('https://token-plan-ams.xiaomimimo.com/v1'));
  expect(api.subject).not.toBe(sgp.subject);
  expect(sgp.subject).not.toBe(ams.subject);
  expect(identityFromAuthBlob('mimo-code', profile('https://token-plan-sgp.xiaomimimo.com/v1/'))).toEqual(sgp);
});
