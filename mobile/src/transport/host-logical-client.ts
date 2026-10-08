import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import { NEXUS_BRIDGE_HOST_KIND, type ConnectionLogSink, type HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { globalWebSocketFactory } from './nexus-bridge-client'
import { loadNexusBridgeDeviceIdentity } from './nexus-bridge-device-store'
import { createNexusBridgeRpcClient } from './nexus-bridge-rpc-adapter'

let nexusLogSeq = 0

function openNexusBridgeClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Desktop Nexus: Remote Bridge (wss + chave do aparelho), sem a fachada/relay do Orca.
  const client: RpcClient = createNexusBridgeRpcClient({
    url: host.endpoint,
    token: host.deviceToken,
    identity: loadNexusBridgeDeviceIdentity,
    createSocket: globalWebSocketFactory,
    onLog: (level, message) =>
      onLog({
        id: `nexus-bridge-${Date.now()}-${++nexusLogSeq}`,
        ts: Date.now(),
        level,
        message
      })
  })
  return client
}

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  if (host.kind === NEXUS_BRIDGE_HOST_KIND) {
    return openNexusBridgeClient(host, onLog)
  }
  // Why: the stable facade owns app-visible RPC/subscription state while the
  // direct socket remains a replaceable first physical generation.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPathForEndpoint(host, host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  const endpointLifecycle = startMobileEndpointLifecycle(logical, host, onLog)
  endpointLifecycle.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(state === 'active')
  })
  const closeLogical = logical.close
  logical.close = () => {
    appStateSubscription.remove()
    endpointLifecycle.stop()
    closeLogical()
  }
  const notifyLogicalForeground = logical.notifyForeground
  logical.notifyForeground = (reason = 'focus') => {
    // Why: a nudge while already foreground must not re-enter setForeground —
    // that path suspended healthy relays; the supervisor probes or replaces instead.
    endpointLifecycle.nudge(reason)
    notifyLogicalForeground(reason)
  }
  return logical
}
