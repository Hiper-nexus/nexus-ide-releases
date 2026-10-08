// Chave do aparelho para a Remote Bridge do Nexus (F-968). Mesmo contrato do
// PWA "Nexus Remote" (src/main/remote/remote-client-page.ts): ECDSA P-256, chave
// pública em JWK e assinatura IEEE-P1363 (r||s, 64 bytes) em base64url, que é o
// que src/main/remote/remote-device-authority.ts verifica.
//
// TS puro (sem React Native): o teste de ponta a ponta do desktop importa este
// módulo por caminho. Hermes não tem WebCrypto nem getRandomValues, então a
// aleatoriedade entra por parâmetro (expo-crypto no app, node:crypto no teste) e
// a assinatura é determinística (RFC 6979) — assinar não precisa de RNG.
import { p256 } from '@noble/curves/nist'

export type NexusBridgeDevicePublicKey = {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: string
  readonly y: string
}

export type NexusBridgeDeviceIdentity = {
  readonly deviceId: string
  readonly publicKey: NexusBridgeDevicePublicKey
  /** Assina o desafio (texto UTF-8) e devolve a assinatura P1363 em base64url. */
  readonly sign: (challenge: string) => string
}

/** O que vai para o SecureStore: só o segredo e o id; a pública é derivada. */
export type StoredNexusBridgeDeviceKey = {
  readonly v: 1
  readonly deviceId: string
  readonly secretKey: string
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/
// mapHashToField exige ≥ 40 bytes para n de 256 bits; 48 é o tamanho de semente da curva.
const SECRET_SEED_BYTES = 48

export function createNexusBridgeDeviceKey(
  randomBytes: (length: number) => Uint8Array
): StoredNexusBridgeDeviceKey {
  return {
    v: 1,
    deviceId: base64UrlEncode(randomBytes(24)),
    secretKey: base64UrlEncode(p256.utils.randomSecretKey(randomBytes(SECRET_SEED_BYTES)))
  }
}

export function parseStoredNexusBridgeDeviceKey(
  raw: string | null
): StoredNexusBridgeDeviceKey | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<StoredNexusBridgeDeviceKey> | null
    if (
      value?.v !== 1 ||
      typeof value.deviceId !== 'string' ||
      !DEVICE_ID_PATTERN.test(value.deviceId) ||
      typeof value.secretKey !== 'string' ||
      !SECRET_KEY_PATTERN.test(value.secretKey) ||
      !p256.utils.isValidSecretKey(base64UrlDecode(value.secretKey))
    ) {
      return null
    }
    return { v: 1, deviceId: value.deviceId, secretKey: value.secretKey }
  } catch {
    return null
  }
}

export function nexusBridgeDeviceIdentity(
  stored: StoredNexusBridgeDeviceKey
): NexusBridgeDeviceIdentity {
  const secretKey = base64UrlDecode(stored.secretKey)
  // 0x04 || X(32) || Y(32): o JWK leva X e Y em base64url sem padding (43 chars).
  const point = p256.getPublicKey(secretKey, false)
  return {
    deviceId: stored.deviceId,
    publicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.subarray(1, 33)),
      y: base64UrlEncode(point.subarray(33, 65))
    },
    sign: (challenge) =>
      base64UrlEncode(
        p256
          .sign(new TextEncoder().encode(challenge), secretKey, { prehash: true })
          .toCompactRawBytes()
      )
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index)
  }
  return out
}
