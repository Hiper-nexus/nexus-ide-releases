import type { RemoteBridgeInfo } from '../../shared/remote-types';
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
): Promise<RemoteBridgeRedactedInfo> {
  let info: RemoteBridgeInfo;
  switch (action) {
    case 'start':
      info = await startRemoteBridge(port === undefined ? {} : { port });
      break;
    case 'stop':
      info = stopRemoteBridge();
      break;
    case 'rotate_pairing':
      info = rotateRemotePairing();
      break;
    case 'status':
    default:
      info = getRemoteBridgeInfo();
      break;
  }
  return redactRemoteBridgeSecrets(info);
}
