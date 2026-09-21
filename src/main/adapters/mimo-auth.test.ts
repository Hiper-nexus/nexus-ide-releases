import { expect, it } from 'vitest';
import { mimoNativePaths, parseMimoAuth, mimoAuthSnapshot, mimoCredentialSupportsModel } from './mimo-auth';
it('resolves the official split XDG paths and the isolated CLI home', () => {
  expect(mimoNativePaths('/operator', {}).authFile).toBe('/operator/.local/share/mimocode/auth.json');
  expect(mimoNativePaths('/operator', { MIMOCODE_HOME: '/private/account' })).toMatchObject({ data: '/private/account/data', authFile: '/private/account/data/auth.json', config: '/private/account/config' });
  expect(() => mimoNativePaths('/operator', { MIMOCODE_HOME: 'relative' })).toThrow();
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
