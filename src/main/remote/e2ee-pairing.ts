// Nexus E2EE pairing for remote/mobile transport.
// Protocol shape adapted from stablyai/orca relay pairing concepts @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus implementation.
// See third_party/licenses/orca-MIT.txt.

import { createHash, randomBytes } from 'node:crypto';

export type PairingChallenge = {
  readonly pairingId: string;
  readonly challenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type PairingSession = {
  readonly pairingId: string;
  readonly deviceId: string;
  readonly sharedSecretHash: string;
  readonly pairedAt: number;
};

const PAIRING_TTL_MS = 5 * 60 * 1000;

export function createPairingChallenge(now = Date.now()): PairingChallenge {
  return {
    pairingId: randomBytes(16).toString('hex'),
    challenge: randomBytes(32).toString('base64url'),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  };
}

/**
 * Completes pairing when the device returns HMAC-like proof of challenge.
 * Proof = sha256(challenge + deviceSecret) hex — transport encrypts separately.
 */
export function completePairing(input: {
  challenge: PairingChallenge;
  deviceId: string;
  deviceSecret: string;
  proof: string;
  now?: number;
}): PairingSession | null {
  const now = input.now ?? Date.now();
  if (now > input.challenge.expiresAt) return null;
  const expected = createHash('sha256')
    .update(input.challenge.challenge)
    .update(input.deviceSecret)
    .digest('hex');
  if (expected !== input.proof) return null;
  return {
    pairingId: input.challenge.pairingId,
    deviceId: input.deviceId,
    sharedSecretHash: createHash('sha256')
      .update(input.deviceSecret)
      .update(input.challenge.pairingId)
      .digest('hex'),
    pairedAt: now,
  };
}

export function makePairingProof(challenge: string, deviceSecret: string): string {
  return createHash('sha256').update(challenge).update(deviceSecret).digest('hex');
}
