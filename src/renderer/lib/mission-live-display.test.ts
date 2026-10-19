import { describe, expect, it } from 'vitest';
import type { MissionSnapshot } from '../../shared/mission-engine-contract';
import { missionLiveDisplay } from './mission-live-display';

const snapshot = {
  id: 'mission-a', state: 'running', allowedActions: ['direct', 'stop'],
  stateReason: { code: 'awaiting-instruction', label: 'Aguardando sua instrução' },
  agents: [
    { id: 'leader', category: 'orchestrator', paneId: 'leader-pane', state: 'queued', terminalLive: true },
    { id: 'helper', category: 'executor', paneId: 'helper-pane', state: 'queued', terminalLive: true },
  ],
} as MissionSnapshot;

describe('missionLiveDisplay — same busy presentation as the rail', () => {
  it('updates coordination and helpers together and removes the contradictory idle reason', () => {
    const result = missionLiveDisplay(snapshot, new Map([
      ['leader-pane', 'busy'], ['helper-pane', 'busy'],
    ]), new Map())!;
    expect(result.agents.map((agent) => agent.state)).toEqual(['working', 'working']);
    expect(result.stateReason).toBeUndefined();
    expect(result.state).toBe(snapshot.state);
    expect(result.allowedActions).toBe(snapshot.allowedActions);
    expect(snapshot.agents[0].state).toBe('queued');
  });
  it('keeps the idle reason once the shared presentation becomes idle', () => {
    expect(missionLiveDisplay(snapshot, new Map([['leader-pane', 'idle']]), new Map())).toBe(snapshot);
  });
  it('ignores busy panes outside this mission and parked sessions', () => {
    expect(missionLiveDisplay(snapshot, new Map([['other-pane', 'busy']]), new Map())).toBe(snapshot);
    expect(missionLiveDisplay(snapshot, new Map([['leader-pane', 'busy']]), new Map([['leader-pane', {}]]))).toBe(snapshot);
  });
  it.each(['failed', 'waiting', 'blocked', 'done'] as const)('preserves explicit %s agent state', (state) => {
    const input = { ...snapshot, agents: [{ ...snapshot.agents[0], state }] };
    expect(missionLiveDisplay(input, new Map([['leader-pane', 'busy']]), new Map())).toBe(input);
  });
  it('preserves Main lifecycle, dead sessions and actual block reasons', () => {
    const stopped = { ...snapshot, state: 'blocked_technical' as const };
    expect(missionLiveDisplay(stopped, new Map([['leader-pane', 'busy']]), new Map())).toBe(stopped);
    const dead = { ...snapshot, agents: [{ ...snapshot.agents[0], terminalLive: false }] };
    expect(missionLiveDisplay(dead, new Map([['leader-pane', 'busy']]), new Map())).toBe(dead);
    const live = { ...snapshot, stateReason: { code: 'other', label: 'Specific reason' } };
    expect(missionLiveDisplay(live, new Map([['leader-pane', 'busy']]), new Map())?.stateReason).toBe(live.stateReason);
  });
});
