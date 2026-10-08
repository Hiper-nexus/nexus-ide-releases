import { describe, expect, it } from 'vitest'
import {
  NEXUS_EXPIRED_CODE_MESSAGE,
  NEXUS_SELF_SIGNED_MESSAGE,
  parseNexusBridgePairingUrl
} from './nexus-bridge-pairing'

describe('parseNexusBridgePairingUrl (QR do desktop Nexus)', () => {
  it('turns the Tailscale Serve QR into a wss target on the same origin', () => {
    expect(parseNexusBridgePairingUrl(' https://Mac.tail1234.ts.net/#code=7k2m9qxr ')).toEqual({
      kind: 'nexus-bridge',
      endpoint: 'wss://mac.tail1234.ts.net',
      origin: 'https://mac.tail1234.ts.net',
      host: 'mac.tail1234.ts.net',
      code: '7K2M9QXR'
    })
    expect(parseNexusBridgePairingUrl('https://box.example.com:8443#code=ABCDEFGH')).toMatchObject(
      { endpoint: 'wss://box.example.com:8443', code: 'ABCDEFGH' }
    )
  })

  it('refuses the self-signed LAN/loopback bridge with the Tailscale explanation', () => {
    for (const url of [
      'https://192.168.0.10:51234/#code=7K2M9QXR',
      'https://100.101.102.103:51234/#code=7K2M9QXR',
      'https://127.0.0.1:51234/#code=7K2M9QXR',
      'https://localhost:51234/#code=7K2M9QXR',
      'https://[fd7a:115c::1]:51234/#code=7K2M9QXR'
    ]) {
      expect(parseNexusBridgePairingUrl(url)).toEqual({
        kind: 'error',
        message: NEXUS_SELF_SIGNED_MESSAGE
      })
    }
  })

  it('explains an empty/expired code and plain http instead of failing later', () => {
    expect(parseNexusBridgePairingUrl('https://mac.tail.ts.net/#code=')).toEqual({
      kind: 'error',
      message: NEXUS_EXPIRED_CODE_MESSAGE
    })
    // 0/O/1/I/L ficam fora do alfabeto do desktop.
    expect(parseNexusBridgePairingUrl('https://mac.tail.ts.net/#code=0OIL1234')).toMatchObject({
      kind: 'error'
    })
    expect(parseNexusBridgePairingUrl('http://mac.tail.ts.net/#code=7K2M9QXR')).toMatchObject({
      kind: 'error'
    })
  })

  it('leaves Orca QR codes and unrelated links to the Orca parser', () => {
    expect(parseNexusBridgePairingUrl('orca://pair?code=eyJ2IjoxfQ')).toBeNull()
    expect(parseNexusBridgePairingUrl('https://example.com/docs')).toBeNull()
    expect(parseNexusBridgePairingUrl('7K2M9QXR')).toBeNull()
  })
})
