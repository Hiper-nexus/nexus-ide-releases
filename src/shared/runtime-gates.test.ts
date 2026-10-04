import { expect, it } from 'vitest';
import { parseRuntimeRequest, assertRuntimeProof, RUNTIME_REQUIRED } from './runtime-gates';
const nonce = '11111111-1111-4111-8111-111111111111';
it('requires nonce, exact operation and bounded IDs on the private transport', () => {
  expect(parseRuntimeRequest({ nonce, operation: 'observe', missionId: 'm1' })).not.toBeNull();
  for (const value of [{ nonce, operation: 'set-status', missionId: 'm1' }, { nonce, operation: 'observe', missionId: 'm1', scope: '/other' },
    { nonce: 'old', operation: 'observe', missionId: 'm1' }]) expect(parseRuntimeRequest(value)).toBeNull();
});
it('never calls a partial, disabled, synthetic-CLI or unproved field release acceptance', () => {
  const checks = Object.fromEntries(RUNTIME_REQUIRED.map(name => [name, true]));
  const proof = { nonce, pid: 1234, phase: 'exercise', packaged: true, appVersion: '0.76.192', checks,
    cli: { adapterId: 'claude', version: '2.1.289', binarySha256: 'a'.repeat(64), actualInstalled: true }, voice: { grant: 'granted', tracks: 1, ended: 1, contexts: 1, closed: 1, frames: 1 } };
  expect(() => assertRuntimeProof(proof, 'exercise')).not.toThrow();
  for (const mutate of [(v: typeof proof) => { v.checks['handoff-ack'] = false; }, (v: typeof proof) => { v.cli.actualInstalled = false; },
    (v: typeof proof) => { v.voice.ended = 0; }, (v: typeof proof) => { v.voice.grant = 'denied'; }]) {
    const value = structuredClone(proof); mutate(value); expect(() => assertRuntimeProof(value, 'exercise')).toThrow();
  }
});
