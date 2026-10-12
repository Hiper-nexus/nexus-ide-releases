import { expect, it } from 'vitest';
import path from 'node:path';
import { runtimeGateConfiguration } from './runtime-gate-mode';
const userData = '/tmp/private';
const env = { HOME: path.join(userData, 'home'), NEXUS_USER_DATA_DIR: userData, NEXUS_PACKAGED_SMOKE: '1', NEXUS_SMOKE_RUNTIME_GATES: '1',
  NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://127.0.0.1:23456', NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: '11111111-1111-4111-8111-111111111111', NEXUS_SMOKE_RUNTIME_PHASE: 'exercise' };
it('never accepts production, a foreign profile, external gateway or ambiguous phase', () => {
  const base = { smokeTest: true, packaged: true, userData, env };
  expect(runtimeGateConfiguration(base)?.phase).toBe('exercise');
  for (const changed of [{ smokeTest: false }, { packaged: false }, { env: { ...env, HOME: '/operator' } },
    { env: { ...env, NEXUS_SMOKE_RUNTIME_GATEWAY: 'https://example.invalid' } }, { env: { ...env, NEXUS_SMOKE_RUNTIME_PHASE: 'other' } }]) expect(runtimeGateConfiguration({ ...base, ...changed })).toBeNull();
});
