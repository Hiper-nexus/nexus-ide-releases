// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: maps agent-hook
// activity onto Nexus PaneSessionState; documents §12.4 invariant that hooks
// never authorize sensors/evidence/mission completion.

import type { AgentStatusState } from '../../shared/agent-status-types';
import type { PaneSessionState } from '../../shared/types';

/**
 * Nexus invariant (§12.4): provider hooks inform UI/activity only.
 * They MUST NOT be treated as sensors, review, evidence, or mission completion.
 */
export const AGENT_HOOK_IS_ACTIVITY_ONLY = true as const;

export type AgentHookActivityMapping = {
  readonly paneSessionState: PaneSessionState;
  readonly activityOnly: true;
  readonly authorizesEvidence: false;
  readonly authorizesMissionCompletion: false;
};

/**
 * Map explicit agent-hook status → pane session presentation state.
 * `done` maps to `idle` (work finished from provider view) without claiming
 * Nexus evidence/sensor success.
 */
export function mapAgentHookStatusToPaneSession(
  state: AgentStatusState,
): AgentHookActivityMapping {
  let paneSessionState: PaneSessionState;
  switch (state) {
    case 'working':
      paneSessionState = 'busy';
      break;
    case 'blocked':
    case 'waiting':
      // Still an active agent turn; surface as busy so UI does not look idle.
      paneSessionState = 'busy';
      break;
    case 'done':
      paneSessionState = 'idle';
      break;
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      paneSessionState = 'idle';
    }
  }
  return Object.freeze({
    paneSessionState,
    activityOnly: true as const,
    authorizesEvidence: false as const,
    authorizesMissionCompletion: false as const,
  });
}
