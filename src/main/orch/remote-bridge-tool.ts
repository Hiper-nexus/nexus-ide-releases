import type { RemoteBridgeInfo } from '../../shared/remote-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getRemoteBridgeInfo,
  redactRemoteBridgeSecrets,
  rotateRemotePairing,
  startRemoteBridge,
  stopRemoteBridge,
  type RemoteBridgeRedactedInfo,
} from '../remote/remote-bridge';

export async function runRemoteBridgeToolAction(
  action: string,
  port?: number,
  scope?: ProjectExecutionScope,
): Promise<RemoteBridgeRedactedInfo> {
  if (!scope) throw new Error('remote bridge action requires project scope');
  let info: RemoteBridgeInfo;
  switch (action) {
    case 'start':
      info = await startRemoteBridge(port === undefined ? {} : { port }, scope);
      break;
    case 'stop':
      info = stopRemoteBridge(scope);
      break;
    case 'rotate_pairing':
      info = rotateRemotePairing(scope);
      break;
    case 'status':
    default:
      info = getRemoteBridgeInfo(scope);
      break;
  }
  return redactRemoteBridgeSecrets(info);
}
