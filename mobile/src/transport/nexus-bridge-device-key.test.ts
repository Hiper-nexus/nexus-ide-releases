import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createNexusBridgeDeviceKey,
  nexusBridgeDeviceIdentity,
  parseStoredNexusBridgeDeviceKey
} from './nexus-bridge-device-key'

const randomBytes = (length: number) => new Uint8Array(crypto.randomBytes(length))

describe('Nexus bridge device key (P-256, contrato do PWA)', () => {
  it('produces the JWK + P1363 base64url signature the desktop verifier accepts', () => {
    const stored = createNexusBridgeDeviceKey(randomBytes)
    const identity = nexusBridgeDeviceIdentity(stored)
    // Os mesmos padrões de src/main/remote/remote-device-authority.ts.
    expect(identity.deviceId).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(identity.publicKey.x).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(identity.publicKey.y).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const signature = identity.sign('nexus-remote-pair-v1:7K2M9QXR')
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    const key = crypto.createPublicKey({ key: { ...identity.publicKey }, format: 'jwk' })
    const verify = (message: string) =>
      crypto.verify(
        'sha256',
        Buffer.from(message),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    expect(verify('nexus-remote-pair-v1:7K2M9QXR')).toBe(true)
    expect(verify('nexus-remote-pair-v1:7K2M9QXS')).toBe(false)
  })

  it('round-trips through storage and rejects tampered records', () => {
    const stored = createNexusBridgeDeviceKey(randomBytes)
    const parsed = parseStoredNexusBridgeDeviceKey(JSON.stringify(stored))
    expect(parsed).toEqual(stored)
    expect(nexusBridgeDeviceIdentity(parsed!).publicKey).toEqual(
      nexusBridgeDeviceIdentity(stored).publicKey
    )
    expect(parseStoredNexusBridgeDeviceKey(null)).toBeNull()
    expect(parseStoredNexusBridgeDeviceKey('{"v":1}')).toBeNull()
    expect(
      parseStoredNexusBridgeDeviceKey(JSON.stringify({ ...stored, secretKey: 'A'.repeat(43) }))
    ).toBeNull()
  })
})
