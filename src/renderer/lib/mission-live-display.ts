import type { MissionSnapshot } from '../../shared/mission-engine-contract';
import { MISSION_AWAITING_INSTRUCTION_REASON_CODE } from '../../shared/session-restore-liveness';
import type { PaneSessionState } from '../../shared/types';
import { resolveRosterState } from './agent-roster';

/**
 * Main owns lifecycle/permissions; the rail holds busy briefly across streaming
 * gaps. Apply that same presentation signal to board members and its idle copy.
 * Never promote a blocked/failed agent or infer activity from another mission.
 */
export function missionLiveDisplay(
  snapshot: MissionSnapshot | null,
  states: ReadonlyMap<string, PaneSessionState>,
  parked: ReadonlyMap<string, unknown>,
): MissionSnapshot | null {
  if (!snapshot || snapshot.state !== 'running') return snapshot;
  let changed = false;
  let liveWorking = false;
  const agents = snapshot.agents.map((agent) => {
    if (!agent.paneId || agent.terminalLive === false ||
      (agent.state !== 'queued' && agent.state !== 'working')) return agent;
    if (resolveRosterState(states.get(agent.paneId), parked.has(agent.paneId)).kind !== 'working') return agent;
    liveWorking = true;
    if (agent.state === 'working') return agent;
    changed = true;
    return { ...agent, state: 'working' as const };
  });
  const clearIdleReason = liveWorking &&
    snapshot.stateReason?.code === MISSION_AWAITING_INSTRUCTION_REASON_CODE;
  if (!changed && !clearIdleReason) return snapshot;
  return { ...snapshot, agents, ...(clearIdleReason ? { stateReason: undefined } : {}) };
}
