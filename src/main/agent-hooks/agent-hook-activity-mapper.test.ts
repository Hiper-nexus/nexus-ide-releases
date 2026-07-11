import { describe, expect, it } from 'vitest';
import {
  AGENT_HOOK_IS_ACTIVITY_ONLY,
  mapAgentHookStatusToPaneSession,
} from './agent-hook-activity-mapper';

describe('mapAgentHookStatusToPaneSession', () => {
  it('maps working/blocked/waiting to busy and done to idle', () => {
    expect(mapAgentHookStatusToPaneSession('working').paneSessionState).toBe('busy');
    expect(mapAgentHookStatusToPaneSession('blocked').paneSessionState).toBe('busy');
    expect(mapAgentHookStatusToPaneSession('waiting').paneSessionState).toBe('busy');
    expect(mapAgentHookStatusToPaneSession('done').paneSessionState).toBe('idle');
  });

  it('never authorizes evidence or mission completion (Nexus §12.4)', () => {
    for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
      const mapped = mapAgentHookStatusToPaneSession(state);
      expect(mapped.activityOnly).toBe(true);
      expect(mapped.authorizesEvidence).toBe(false);
      expect(mapped.authorizesMissionCompletion).toBe(false);
    }
    expect(AGENT_HOOK_IS_ACTIVITY_ONLY).toBe(true);
  });
});
