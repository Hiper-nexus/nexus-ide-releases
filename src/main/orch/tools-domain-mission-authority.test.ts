import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));

import { buildDomainTools } from './tools-domain';

const scope = testProjectScope();

function context(role: 'worker' | 'orchestrator'): AgentGateContext {
  return {
    token: `${role}-token`,
    label: role,
    role,
    missionId: 'mission-existing',
    sessionId: `${role}-session`,
    contextRevision: 'c'.repeat(64),
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function missionCreateTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_mission_create',
  );
  if (!tool) throw new Error('mission create tool is not registered');
  return tool;
}

describe('mission creation authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['worker', 'orchestrator'] as const)(
    'does not let a %s create a mission or promote its own gate context',
    async (role) => {
      const ctx = context(role);

      await expect(
        missionCreateTool().handler({ title: 'Privilege escalation' }, ctx),
      ).rejects.toThrow(/only a user-owned session may create a mission/i);

      expect(ctx.role).toBe(role);
      expect(ctx.missionId).toBe('mission-existing');
      expect(mocks.getProjectDomainStores).not.toHaveBeenCalled();
    },
  );
});
