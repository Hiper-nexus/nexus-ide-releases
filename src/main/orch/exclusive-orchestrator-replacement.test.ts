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

function session(overrides: Partial<OwnedAgentSessionInfo> = {}): OwnedAgentSessionInfo {
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

function harness(options: {
  sessions?: OwnedAgentSessionInfo[];
  status?: Mission['status'];
  mutateOnSettle?: boolean;
} = {}) {
  let sessions = options.sessions ?? [session()];
  let current = mission(options.status);
  const block = vi.fn(() => {
    current = { ...current, status: 'blocked' };
    return current;
  });
  const suite = {
    missions: {
      get: vi.fn(() => current),
      block,
    },
  } as unknown as ProjectDomainStoreSuite;
  const deps: ExclusiveOrchestratorReplacementDeps = {
    listAgentSessions: () => sessions,
    storesForScope: () => suite,
    prepareTermination: ({ missionId }) => ({
      missionId,
      missionTitle: current.title,
      reason: 'authority-revoked',
      sessionIds: ['pty-old'],
      fence: `runtime-${current.updatedAt}`,
    }),
    settleDemotion: vi.fn(async () => {
      if (options.mutateOnSettle !== false) sessions = [];
      return {
        mission: current,
        termination: {
          ok: true,
          terminatedSessionIds: ['pty-old'],
        },
      };
    }),
  };
  return { deps, block, suite, setSessions: (next: OwnedAgentSessionInfo[]) => {
    sessions = next;
  } };
}

describe('exclusive orchestrator replacement', () => {
  it('does nothing for adapters without a shared authentication family', () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'codex' },
      h.deps,
    );
    expect(candidate.authFamily).toBeNull();
    expect(candidate.entries).toEqual([]);
  });

  it('seals the old main-owned mission and physical session for one dialog', () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'claude' },
      h.deps,
    );
    expect(candidate.entries).toEqual([
      expect.objectContaining({
        missionId: 'mission-old',
        missionTitle: 'Missão anterior',
        sessionIds: ['pty-old'],
        runtimeFence: 'runtime-1',
      }),
    ]);
    expect(exclusiveReplacementDialogSummary(candidate)).toMatch(
      /substitui 1 missão.*saída física.*Missão anterior/i,
    );
  });

  it('fails closed for an exclusive process without mission authority', () => {
    const h = harness({ sessions: [session({ missionId: undefined })] });
    expect(() =>
      prepareExclusiveOrchestratorReplacement(
        { incomingMissionId: 'mission-new', incomingAdapterId: 'claude' },
        h.deps,
      ),
    ).toThrow(/without mission authority/i);
  });

  it('rechecks the exact fence, revokes the old mission, and proves exit', async () => {
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
    ).resolves.toEqual(['pty-old']);
    expect(h.block).toHaveBeenCalledWith('mission-old', 'user');
    expect(h.deps.settleDemotion).toHaveBeenCalledOnce();
  });

  it('rejects a changed runtime before revoking anything', async () => {
    const h = harness();
    const candidate = prepareExclusiveOrchestratorReplacement(
      { incomingMissionId: 'mission-new', incomingAdapterId: 'claude' },
      h.deps,
    );
    h.setSessions([
      session({ sessionId: 'pty-replaced-during-dialog' }),
    ]);
    await expect(
      applyExclusiveOrchestratorReplacement(
        {
          incomingMissionId: 'mission-new',
          incomingAdapterId: 'claude',
          expectedFence: candidate.fence,
        },
        h.deps,
      ),
    ).rejects.toThrow(
      /changed while mission approval was open|not bound to the authoritative runtime/i,
    );
    expect(h.block).not.toHaveBeenCalled();
  });
});
