import type { ProjectExecutionScope } from '../../shared/types';
import { listAgentSessions } from '../pty/pty-manager';
import type { McpToolInvocation } from './mcp-protocol';
import { sameProjectScope } from './project-scoped-broadcast';

/** Presentation can move; the already-promoted physical leader owns this notice. */
export function promotedLeaderNoticeAuthority(input: {
  scope: ProjectExecutionScope;
  paneId: string;
  missionId: string;
  sessionId: string;
}): { adapterId: string; invocation: McpToolInvocation } {
  const physical = listAgentSessions().find(agent => agent.sessionId === input.sessionId);
  const assertCurrentAuthority = () => {
    const live = listAgentSessions().find(agent => agent.sessionId === input.sessionId);
    if (!physical || !live || live.paneId !== input.paneId ||
        live.missionId !== input.missionId || live.role !== 'orchestrator' ||
        live.adapterId !== physical.adapterId || live.accountId !== physical.accountId ||
        !sameProjectScope(live.scope, physical.scope) ||
        !sameProjectScope(live.coordinationScope ?? live.scope, input.scope)) {
      throw new Error('operator_tab_mission_authority_changed');
    }
  };
  assertCurrentAuthority();
  return { adapterId: physical!.adapterId, invocation: { assertCurrentAuthority } };
}
