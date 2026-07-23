import crypto from 'node:crypto';

export interface RemoteDevicePublicKey {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export interface RemoteDeviceIdentity {
  readonly deviceId: string;
  readonly publicKey: RemoteDevicePublicKey;
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const P256_P1363_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export function parseRemoteDeviceIdentity(input: {
  readonly deviceId: unknown;
  readonly publicKey: unknown;
}): RemoteDeviceIdentity | null {
  if (
    typeof input.deviceId !== 'string' ||
    !DEVICE_ID_PATTERN.test(input.deviceId)
  ) {
    return null;
  }
  if (!input.publicKey || typeof input.publicKey !== 'object') return null;
  const key = input.publicKey as Record<string, unknown>;
  if (
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !BASE64URL_COORDINATE_PATTERN.test(key.x) ||
    !BASE64URL_COORDINATE_PATTERN.test(key.y)
  ) {
    return null;
  }
  try {
    crypto.createPublicKey({
      key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      format: 'jwk',
    });
  } catch {
    return null;
  }
  return {
    deviceId: input.deviceId,
    publicKey: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
  };
}

export function remoteDeviceKeyFingerprint(
  key: RemoteDevicePublicKey,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([key.kty, key.crv, key.x, key.y]))
    .digest('hex');
}

export function verifyRemoteDeviceSignature(input: {
  readonly publicKey: RemoteDevicePublicKey;
  readonly challenge: string;
  readonly signature: unknown;
}): boolean {
  if (
    typeof input.signature !== 'string' ||
    !P256_P1363_SIGNATURE_PATTERN.test(input.signature)
  ) {
    return false;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signature, 'base64url');
  } catch {
    return false;
  }
  if (signature.length !== 64) {
    return false;
  }
  try {
    const publicKey = crypto.createPublicKey({
      key: input.publicKey,
      format: 'jwk',
    });
    return crypto.verify(
      'sha256',
      Buffer.from(input.challenge, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    return false;
  }
}
