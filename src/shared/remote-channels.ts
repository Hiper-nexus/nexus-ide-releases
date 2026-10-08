export const REMOTE_CHANNELS = {
  bridgeStatus: 'remote:bridge.status',
  bridgeStart: 'remote:bridge.start',
  bridgeStop: 'remote:bridge.stop',
  bridgeRotatePairing: 'remote:bridge.rotatePairing',
  bridgeRevokeTokens: 'remote:bridge.revokeTokens',
  bridgeSetDeviceScopes: 'remote:bridge.setDeviceScopes', // MOB-12
  remoteSpawnDetect: 'remote:spawn.detect',
  remoteSpawnList: 'remote:spawn.list',
  remoteSpawnCreate: 'remote:spawn.create',
  sshList: 'remote:ssh.list',
  sshConnect: 'remote:ssh.connect',
  sshImportConfig: 'remote:ssh.importConfig',
  sshRemove: 'remote:ssh.remove',
} as const;
