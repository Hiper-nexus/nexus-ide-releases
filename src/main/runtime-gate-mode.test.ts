import { expect, it } from 'vitest';
import { runtimeGateConfiguration } from './runtime-gate-mode';
const env = { HOME: '/tmp/private/home', NEXUS_USER_DATA_DIR: '/tmp/private', NEXUS_PACKAGED_SMOKE: '1', NEXUS_SMOKE_RUNTIME_GATES: '1',
  NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://127.0.0.1:23456', NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: '11111111-1111-4111-8111-111111111111', NEXUS_SMOKE_RUNTIME_PHASE: 'exercise' };
it('never accepts production, a foreign profile, external gateway or ambiguous phase', () => {
  const base = { smokeTest: true, packaged: true, userData: '/tmp/private', env };
  expect(runtimeGateConfiguration(base)?.phase).toBe('exercise');
  for (const changed of [{ smokeTest: false }, { packaged: false }, { env: { ...env, HOME: '/operator' } },
    { env: { ...env, NEXUS_SMOKE_RUNTIME_GATEWAY: 'https://example.invalid' } }, { env: { ...env, NEXUS_SMOKE_RUNTIME_PHASE: 'other' } }]) expect(runtimeGateConfiguration({ ...base, ...changed })).toBeNull();
});
