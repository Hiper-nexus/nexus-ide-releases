import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hasSubscriptionAuth, resetSubscriptionAuthCacheForTests } from './subscription-auth';
let home = '';
afterEach(() => {
  vi.unstubAllEnvs();
  resetSubscriptionAuthCacheForTests();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});
it('checks the exact current MiMo credential after generic and model cache hits', () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-auth-cache-'));
  vi.stubEnv('MIMOCODE_HOME', home);
  const file = path.join(home, 'data/auth.json');
  fs.mkdirSync(path.dirname(file));
  const save = (baseUrl: string) => fs.writeFileSync(file, JSON.stringify({ xiaomi: {
    type: 'api', key: 'fixture', metadata: { uid: 'test', base_url: baseUrl },
  } }));
  save('https://token-plan-sgp.xiaomimimo.com/v1');
  expect(hasSubscriptionAuth('mimo-code')).toBe(true);
  expect(hasSubscriptionAuth('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBe(false);
  save('https://api.xiaomimimo.com/v1');
  expect(hasSubscriptionAuth('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBe(true);
  save('https://token-plan-sgp.xiaomimimo.com/v1');
  expect(hasSubscriptionAuth('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBe(false);
});
