import { NexusBridgeClient, globalWebSocketFactory, type NexusBridgeLog } from './nexus-bridge-client'
import { loadNexusBridgeDeviceIdentity } from './nexus-bridge-device-store'
import type { NexusBridgePairingTarget } from './nexus-bridge-pairing'
import { resolvePairingHostIdentity, saveHost } from './host-store'
import { NEXUS_BRIDGE_HOST_KIND } from './types'

/** Pareia com a Remote Bridge do desktop Nexus e salva o host (token no Keychain). */
export async function pairNexusBridgeHost(args: {
  target: NexusBridgePairingTarget
  timeoutMs: number
  onLog?: NexusBridgeLog
}): Promise<{ hostId: string }> {
  const client = new NexusBridgeClient({
    url: args.target.endpoint,
    identity: loadNexusBridgeDeviceIdentity,
    createSocket: globalWebSocketFactory,
    requestTimeoutMs: args.timeoutMs,
    onLog: args.onLog
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    args.onLog?.('info', `abrindo ${args.target.endpoint}`)
    const issued = await Promise.race([
      client.pair(args.target.code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('o desktop não respondeu (rede, tailnet ou HTTPS)')),
          args.timeoutMs
        )
      })
    ])
    args.onLog?.('info', 'pareado; salvando o host')
    // Re-parear o mesmo desktop (mesmo origin) reaproveita o card em vez de duplicar.
    const dedupKey = `${NEXUS_BRIDGE_HOST_KIND}:${args.target.origin}`
    const newHostId = `nexus-${Date.now().toString(36)}`
    const identity = await resolvePairingHostIdentity(dedupKey, newHostId)
    await saveHost({
      id: identity.id,
      name: identity.id === newHostId ? `Nexus · ${args.target.host.split('.')[0]}` : identity.name,
      endpoint: args.target.endpoint,
      deviceToken: issued.token,
      publicKeyB64: dedupKey,
      lastConnected: Date.now(),
      kind: NEXUS_BRIDGE_HOST_KIND
    })
    return { hostId: identity.id }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    client.close()
  }
}
