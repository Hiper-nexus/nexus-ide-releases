import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ExpoCrypto from 'expo-crypto'
import { Platform } from 'react-native'
import {
  createNexusBridgeDeviceKey,
  nexusBridgeDeviceIdentity,
  parseStoredNexusBridgeDeviceKey,
  type NexusBridgeDeviceIdentity
} from './nexus-bridge-device-key'
import { readPairingKeychainItem, writePairingKeychainItem } from './pairing-keychain'

// Uma identidade por instalação, como o PWA tem uma por origem: o token de cada
// desktop fica preso a esta chave pública. A chave privada vive só no Keychain/
// Keystore (WHEN_UNLOCKED_THIS_DEVICE_ONLY via pairing-keychain), fora de backup.
const KEY = 'nexus.bridge-device-key.v1'
const WEB_KEY = 'nexus:bridge-device-key:v1'

let loading: Promise<NexusBridgeDeviceIdentity> | null = null

export function loadNexusBridgeDeviceIdentity(): Promise<NexusBridgeDeviceIdentity> {
  loading ??= loadOrCreate().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

async function loadOrCreate(): Promise<NexusBridgeDeviceIdentity> {
  const stored = parseStoredNexusBridgeDeviceKey(await read())
  if (stored) {
    return nexusBridgeDeviceIdentity(stored)
  }
  const created = createNexusBridgeDeviceKey((length) => ExpoCrypto.getRandomBytes(length))
  await write(JSON.stringify(created))
  return nexusBridgeDeviceIdentity(created)
}

function read(): Promise<string | null> {
  // Expo SecureStore não tem backend web; lá o host-device-token-store também usa AsyncStorage.
  return Platform.OS === 'web' ? AsyncStorage.getItem(WEB_KEY) : readPairingKeychainItem(KEY)
}

function write(value: string): Promise<void> {
  return Platform.OS === 'web'
    ? AsyncStorage.setItem(WEB_KEY, value)
    : writePairingKeychainItem(KEY, value)
}
