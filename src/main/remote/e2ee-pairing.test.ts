import { describe, expect, it } from 'vitest';
import {
  completePairing,
  createPairingChallenge,
  makePairingProof,
} from './e2ee-pairing';

describe('e2ee-pairing', () => {
  it('pairs with valid proof and rejects bad/expired', () => {
    const challenge = createPairingChallenge(1_000);
    const secret = 'device-secret';
    const proof = makePairingProof(challenge.challenge, secret);
    const session = completePairing({
      challenge,
      deviceId: 'phone-1',
      deviceSecret: secret,
      proof,
      now: 1_000,
    });
    expect(session?.deviceId).toBe('phone-1');
    expect(session?.sharedSecretHash).toHaveLength(64);
    expect(
      completePairing({
        challenge,
        deviceId: 'phone-1',
        deviceSecret: secret,
        proof: 'deadbeef',
        now: 1_000,
      }),
    ).toBeNull();
    expect(
      completePairing({
        challenge,
        deviceId: 'phone-1',
        deviceSecret: secret,
        proof,
        now: challenge.expiresAt + 1,
      }),
    ).toBeNull();
  });
});
