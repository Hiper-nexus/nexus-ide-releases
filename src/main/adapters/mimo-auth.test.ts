import path from 'node:path';
import { expect, it } from 'vitest';
import { mimoNativePaths, mimoAuthCandidateFiles, parseMimoAuth, mimoAuthSnapshot, mimoCredentialSupportsModel } from './mimo-auth';
it('resolves the official split XDG paths and the isolated CLI home', () => {
  expect(mimoNativePaths('/operator', {}, 'linux').authFile).toBe('/operator/.local/share/mimocode/auth.json');
  expect(mimoNativePaths('/operator', { MIMOCODE_HOME: '/private/account' }, 'linux')).toMatchObject({ data: '/private/account/data', authFile: '/private/account/data/auth.json', config: '/private/account/config' });
  expect(() => mimoNativePaths('/operator', { MIMOCODE_HOME: 'relative' }, 'linux')).toThrow();
});
it('reads the Windows CLI session from the Unix XDG tree and still lists LOCALAPPDATA', () => {
  const home = 'C:\\Users\\operator';
  const local = 'C:\\Users\\operator\\AppData\\Local';
  const paths = mimoNativePaths(home, { LOCALAPPDATA: local, APPDATA: 'C:\\Users\\operator\\AppData\\Roaming', USERPROFILE: home }, 'win32');
  expect(paths.authFile).toBe(path.win32.join(home, '.local', 'share', 'mimocode', 'auth.json'));
  expect(paths.config).toBe(path.win32.join(home, '.config', 'mimocode'));
  expect(mimoAuthCandidateFiles(home, { LOCALAPPDATA: local, USERPROFILE: home }, 'win32')).toEqual([
    paths.authFile,
    path.win32.join(local, 'mimocode', 'auth.json'),
  ]);
});
it('captures only the Xiaomi credential, preserving its stable uid and excluding sibling providers', () => {
  const blob = JSON.stringify({ xiaomi: { type: 'api', key: 'fixture-xiaomi-key', metadata: { uid: 'xiaomi-a', base_url: 'https://api.xiaomimimo.com/v1' } }, openai: { type: 'oauth', access: 'foreign-access' } });
  expect(parseMimoAuth(blob)).toMatchObject({ key: 'fixture-xiaomi-key', uid: 'xiaomi-a', baseUrl: 'https://api.xiaomimimo.com/v1' });
  expect(mimoAuthSnapshot(blob)).not.toContain('foreign-access');
  expect(parseMimoAuth(JSON.stringify({ openai: { key: 'other-provider' } }))).toBeNull();
  expect(parseMimoAuth(JSON.stringify({ xiaomi: { type: 'api', key: '' } }))).toBeNull();
});
it('refuses unexpected credential destinations instead of sending a Xiaomi key elsewhere', () => {
  expect(parseMimoAuth(JSON.stringify({ xiaomi: { type: 'api', key: 'fixture', metadata: { base_url: 'https://example.test/v1' } } }))).toBeNull();
});

it('keeps Token Plan models distinct from the API-only UltraSpeed offering', () => {
  const tokenPlan = JSON.stringify({ xiaomi: { type:'api', key:'fixture-tp', metadata: { uid:'a', base_url:'https://token-plan-sgp.xiaomimimo.com/v1' } } });
  expect(mimoCredentialSupportsModel(tokenPlan, 'xiaomi/mimo-v2.6-pro')).toBe(true);
  expect(mimoCredentialSupportsModel(tokenPlan, 'xiaomi/mimo-v2.6-flash')).toBe(true);
  expect(mimoCredentialSupportsModel(tokenPlan, 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBe(false);
  expect(mimoCredentialSupportsModel(tokenPlan, 'openai/foreign-model')).toBe(false);
});
