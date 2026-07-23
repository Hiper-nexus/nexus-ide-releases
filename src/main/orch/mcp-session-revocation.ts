import { clearSession as clearMcpPermissionSession } from '../jarvis/permissions';
import { tapSessionTermination } from '../pty/pty-manager';
import { releaseSession } from './gate';

/**
 * Revoke the logical bearer/permission authority as soon as main begins a
 * physical PTY teardown. Token-bearing files remain until the actual exit so
 * cleanup can still use the session→token index, but the old process cannot
 * call even read-only or always-allowed MCP tools while it resists SIGTERM.
 */
export function revokeTerminatingSessionMcpAuthority(
  sessionId: string,
): void {
  clearMcpPermissionSession(sessionId);
  releaseSession(sessionId);
}

/** Install the exact production bridge; callers own and invoke the disposer. */
export function installMcpSessionTerminationRevocation(): () => void {
  return tapSessionTermination((sessionId) => {
    revokeTerminatingSessionMcpAuthority(sessionId);
  });
}
