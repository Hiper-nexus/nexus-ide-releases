import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import {
  applyExclusiveOrchestratorReplacement,
  exclusiveReplacementDialogSummary,
  prepareExclusiveOrchestratorReplacement,
  type ExclusiveOrchestratorReplacementDeps,
} from './exclusive-orchestrator-replacement';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
});

function mission(status: Mission['status'] = 'running'): Mission {
  return {
    id: 'mission-old',
    title: 'Missão anterior',
    description: '',
    status,
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function session(
  overrides: Partial<OwnedAgentSessionInfo> = {},
): OwnedAgentSessionInfo {
  return {
    sessionId: 'pty-old',
    paneId: 'pane-old',
    adapterId: 'claude',
    cwd: scope.rootRealPath,
    scope,
    source: 'pending',
    role: 'orchestrator',
    missionId: 'mission-old',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
    ...overrides,
  };
}

function harness() {
  let current = mission();
  const settleDemotion = vi.fn(async () => ({
    mission: current,
    termination: {
      ok: true,
      terminatedSessionIds: ['pty-old'],
    },
  }));
  const deps: ExclusiveOrchestratorReplacementDeps = {
    listAgentSessions: () => [session()],
    storesForScope: () =>
      ({
        missions: {
          get: () => current,
          update: vi.fn(),
          block: vi.fn(),
        },
      }) as unknown as ProjectDomainStoreSuite,
    prepareTermination: ({ missionId }) => ({
      missionId,
      missionTitle: current.title,
      reason: 'authority-revoked',
      sessionIds: ['pty-old'],
      fence: 'runtime-1',
    }),
    settleDemotion,
  };
  return { deps, settleDemotion };
}

describe('exclusive orchestrator replacement', () => {
  it('does not steal another mission when a second Claude Maestro starts', () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'claude' },
      h.deps,
    );
    expect(candidate.authFamily).toBe('claude-shared-login');
    expect(candidate.entries).toEqual([]);
    expect(exclusiveReplacementDialogSummary(candidate)).toBeNull();
  });

  it('does nothing for adapters without a shared authentication family', () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'codex' },
      h.deps,
    );
    expect(candidate.authFamily).toBeNull();
    expect(candidate.entries).toEqual([]);
  });

  it('apply is a no-op and never demotes the live mission', async () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'claude' },
      h.deps,
    );
    await expect(
      applyExclusiveOrchestratorReplacement(
        {
          incomingMissionId: 'mission-new',
          incomingAdapterId: 'claude',
          expectedFence: candidate.fence,
        },
        h.deps,
      ),
    ).resolves.toEqual([]);
    expect(h.settleDemotion).not.toHaveBeenCalled();
  });

  it('rejects a fence that does not match the empty concurrent inventory', async () => {
    const h = harness();
    await expect(
      applyExclusiveOrchestratorReplacement(
        {
          incomingMissionId: 'mission-new',
          incomingAdapterId: 'claude',
          expectedFence: '0'.repeat(64),
        },
        h.deps,
      ),
    ).rejects.toThrow(/changed while mission approval was open/i);
    expect(h.settleDemotion).not.toHaveBeenCalled();
  });
});
