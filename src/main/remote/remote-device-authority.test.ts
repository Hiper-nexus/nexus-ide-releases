import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseRemoteDeviceIdentity,
  remoteDeviceKeyFingerprint,
  verifyRemoteDeviceSignature,
} from './remote-device-authority';

function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const exported = publicKey.export({ format: 'jwk' });
  if (
    exported.kty !== 'EC' ||
    exported.crv !== 'P-256' ||
    typeof exported.x !== 'string' ||
    typeof exported.y !== 'string'
  ) {
    throw new Error('fixture key export failed');
  }
  const identity = parseRemoteDeviceIdentity({
    deviceId: crypto.randomBytes(24).toString('base64url'),
    publicKey: exported,
  });
  if (!identity) throw new Error('fixture identity parse failed');
  return { identity, privateKey };
}

describe('remote-device-authority', () => {
  it('accepts only bounded P-256 public identities', () => {
    const { identity } = fixture();
    expect(remoteDeviceKeyFingerprint(identity.publicKey)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      parseRemoteDeviceIdentity({
        deviceId: 'short',
        publicKey: identity.publicKey,
      }),
    ).toBeNull();
    expect(
      parseRemoteDeviceIdentity({
        deviceId: identity.deviceId,
        publicKey: { ...identity.publicKey, crv: 'P-384' },
      }),
    ).toBeNull();
  });

  it('verifies the paired private key and rejects another key or challenge', () => {
    const { identity, privateKey } = fixture();
    const impostor = fixture();
    const challenge = 'nexus-remote-auth-v1:test';
    const signature = crypto
      .sign('sha256', Buffer.from(challenge), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      })
      .toString('base64url');

    expect(
      verifyRemoteDeviceSignature({
        publicKey: identity.publicKey,
        challenge,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyRemoteDeviceSignature({
        publicKey: impostor.identity.publicKey,
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyRemoteDeviceSignature({
        publicKey: identity.publicKey,
        challenge: `${challenge}:replayed-elsewhere`,
        signature,
      }),
    ).toBe(false);
  });
});
