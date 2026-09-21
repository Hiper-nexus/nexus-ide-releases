import fs from 'node:fs';
import { expect, it } from 'vitest';
import { prepareMimoBenchmarkEnv } from './mimo-benchmark-env';
it('seeds the new CLI models in a private home and keeps the key out of config', () => {
  const prepared = prepareMimoBenchmarkEnv({ PATH:'/bin' }, { XIAOMI_API_KEY:'sk-api-fixture' });
  try {
    const config=JSON.parse(prepared.env.MIMOCODE_CONFIG_CONTENT);
    expect(config.provider.xiaomi.models['mimo-v2.6-pro']).toBeDefined();
    expect(config.provider.xiaomi.options.apiKey).toBe('{env:XIAOMI_API_KEY}');
    expect(prepared.env.MIMOCODE_CONFIG_CONTENT).not.toContain('sk-api-fixture');
    expect(fs.existsSync(prepared.env.MIMOCODE_HOME)).toBe(true);
  } finally { prepared.dispose(); }
  expect(fs.existsSync(prepared.env.MIMOCODE_HOME)).toBe(false);
});
it('refuses Token Plan before creating any benchmark process', () => {
  expect(() => prepareMimoBenchmarkEnv({}, { XIAOMI_API_KEY:'tp-fixture' })).toThrow('Token Plan');
});
