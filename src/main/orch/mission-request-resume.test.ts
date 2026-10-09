import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
  resumeFastLaneMission: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));
vi.mock('./mission-fast-lane', () => ({
  resumeFastLaneMission: mocks.resumeFastLaneMission,
}));

import { buildDomainTools } from './tools-domain';
import { effectPolicyForTool } from './mcp-effect-policy';

const scope = testProjectScope();

function requestResumeTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_mission_request_resume',
  );
  if (!tool) throw new Error('nexus_mission_request_resume is not registered');
  return tool;
}

function context(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'orch-token',
    label: 'Maestro',
    role: 'orchestrator',
    missionId: 'mission-existing',
    sessionId: 'stale-session',
    contextRevision: 'c'.repeat(64),
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

describe('nexus_mission_request_resume (resto F-1040)', () => {
  beforeEach(() => {
    mocks.getProjectDomainStores.mockReset();
    mocks.resumeFastLaneMission.mockReset();
    mocks.resumeFastLaneMission.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is registered and classified as mission-control', () => {
    expect(requestResumeTool().name).toBe('nexus_mission_request_resume');
    expect(effectPolicyForTool('nexus_mission_request_resume')).toBe(
      'mission-control',
    );
  });

  it('a stale Maestro can request resume — the Main rebinds via resumeFastLaneMission', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: (id: string) =>
          id === 'mission-existing'
            ? { id, status: 'running', orchestratorSessionId: 'someone-else' }
            : null,
      },
    });
    const result = await requestResumeTool().handler(
      { missionId: 'mission-existing', note: 'Codex preso como Maestro read-only' },
      context(),
    );
    expect(mocks.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-existing',
      expect.objectContaining({ remountKind: 'automatic' }),
    );
    expect(result).toMatchObject({
      ok: true,
      missionId: 'mission-existing',
      resumed: true,
    });
  });

  it('unknown mission is refused without touching resume', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: { get: () => null },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-missing' },
        context({ missionId: 'mission-missing' }),
      ),
    ).rejects.toThrow(/não existe/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('an unbound user pane cannot remount a mission by argument', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({ id: 'mission-existing', status: 'running' }),
      },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-existing' },
        context({ role: 'user', missionId: undefined }),
      ),
    ).rejects.toThrow(/vinculada a esta sessão/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('an orchestrator bound to mission A cannot remount mission B', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: (id: string) =>
          id === 'mission-b' ? { id, status: 'running' } : null,
      },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-b' },
        context({ role: 'orchestrator', missionId: 'mission-a' }),
      ),
    ).rejects.toThrow(/vinculada a esta sessão/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('worker of another mission cannot request resume', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({ id: 'mission-existing', status: 'running' }),
      },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-existing' },
        context({ role: 'worker', missionId: 'mission-other' }),
      ),
    ).rejects.toThrow(/vinculada a esta sessão/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('F-1043: orchestrator of mission A cannot resume mission B', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: (id: string) => ({ id, status: 'running' }),
      },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-b' },
        context({ role: 'orchestrator', missionId: 'mission-a' }),
      ),
    ).rejects.toThrow(/vinculada a esta sessão/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('F-1042: operator-closed mission is refused BEFORE resume (seal preserved)', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'blocked',
          description:
            '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Encerrada pelo operador.',
        }),
      },
    });
    const result = await requestResumeTool().handler(
      { missionId: 'mission-existing' },
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'mission_closed_by_operator',
    });
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('operator hand without a bound mission is refused (policy: only the linked mission)', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({ id: 'mission-existing', status: 'running' }),
      },
    });
    await expect(
      requestResumeTool().handler(
        { missionId: 'mission-existing' },
        context({ role: 'orchestrator', missionId: undefined }),
      ),
    ).rejects.toThrow(/vinculada a esta sessão/);
    expect(mocks.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('operator-closed mission reports the verdict from resume as well', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({ id: 'mission-existing', status: 'blocked' }),
      },
    });
    mocks.resumeFastLaneMission.mockRejectedValue(
      new Error('mission_closed_by_operator: missão encerrada pelo operador — use Retomar'),
    );
    const result = await requestResumeTool().handler(
      { missionId: 'mission-existing' },
      context(),
    );
    expect(mocks.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-existing',
      expect.objectContaining({ remountKind: 'automatic' }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'mission_closed_by_operator',
    });
  });
});
