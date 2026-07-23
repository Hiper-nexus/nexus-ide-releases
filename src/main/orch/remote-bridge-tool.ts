import type { RemoteBridgeInfo } from '../../shared/remote-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
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
  invocation?: McpToolInvocation,
): Promise<RemoteBridgeRedactedInfo> {
  if (!scope) throw new Error('remote bridge action requires project scope');
  assertMcpInvocationCurrent(invocation);
  let info: RemoteBridgeInfo;
  switch (action) {
    case 'start':
      info = await startRemoteBridge(port === undefined ? {} : { port }, scope);
      try {
        assertMcpInvocationCurrent(invocation);
      } catch (error) {
        // The TLS preparation/listen boundary is not abortable. If authority
        // disappeared while it was awaiting, remove the listener before the
        // rejected MCP call can return.
        stopRemoteBridge(scope);
        throw error;
      }
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
  assertMcpInvocationCurrent(invocation);
  return redactRemoteBridgeSecrets(info);
}
