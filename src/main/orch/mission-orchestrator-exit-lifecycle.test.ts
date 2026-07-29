import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  handleMissionOrchestratorSessionExit,
  prepareMissionOrchestratorExitLifecycle,
  reconcileMissionOrchestratorExits,
  resetMissionOrchestratorExitLifecycleForTests,
  shutdownMissionOrchestratorExitLifecycle,
  suppressIntentionalMissionOrchestratorExit,
  type MissionOrchestratorExitLifecycleDeps,
} from './mission-orchestrator-exit-lifecycle';
import { hashMissionIntentContract } from './mission-pane-authority';
import type { OrchestratorPreDispatchExitInput } from './mission-store';

const scope = testProjectScope({ checkoutId: 'orchestrator-exit-lifecycle' });
const contract = {
  ...compileIntentContract({
    goal: 'Delegar a implementação completa',
    intentVersion: 2,
  }),
  approvedAt: 1_000,
  dispatchedAt: 1_100,
  squadRevisionHash: 'a'.repeat(64),
};
const mission: Mission = {
  id: 'mission-a',
  title: 'Mission A',
  description: '',
  status: 'running',
  squadId: 'squad-a',
  milestones: [],
  learnings: '',
  orchestratorSessionId: 'orch-a',
  intentState: 'dispatched',
  intentVersion: 2,
  intentContract: contract,
  createdAt: 1,
  updatedAt: 2,
};
const authority: OwnedAgentSessionInfo = {
  sessionId: 'orch-a',
  adapterId: 'claude',
  cwd: scope.rootRealPath,
  scope,
  source: 'pending',
  role: 'orchestrator',
  missionId: mission.id,
  squadId: mission.squadId,
  readOnly: false,
  nativeReadOnly: true,
  allowedTools: null,
  allowedSkills: null,
  authoritySeal: {
    intentVersion: 2,
    intentContractHash: hashMissionIntentContract(contract),
    contextRevision: 'b'.repeat(64),
    contractHash: 'c'.repeat(64),
    squadRevisionHash: contract.squadRevisionHash,
  },
};

function fixture() {
  const dispose = vi.fn();
  let exitTap:
    | ((sessionId: string, info: OwnedAgentSessionInfo | null) => void)
    | null = null;
  let currentMission: Mission = { ...mission };
  let liveSession: OwnedAgentSessionInfo | null = authority;
  let persistenceFailures = 0;
  let dispatchIntentVersions: number[] = [];
  const list = vi.fn((status?: string) =>
    !status || currentMission.status === status ? [currentMission] : [],
  );
  const blockOrchestratorPreDispatchExit = vi.fn(
    (input: OrchestratorPreDispatchExitInput) => {
      if (persistenceFailures > 0) {
        persistenceFailures -= 1;
        throw new Error('sqlite unavailable');
      }
      const currentContract = currentMission.intentContract;
      if (
        currentMission.status !== 'running' ||
        !['dispatched', 'executing'].includes(
          currentMission.intentState ?? '',
        ) ||
        currentMission.orchestratorSessionId !==
          input.orchestratorSessionId ||
        (currentMission.intentVersion ?? 0) !== input.intentVersion ||
        !currentContract ||
        hashMissionIntentContract(currentContract) !==
          input.intentContractHash ||
        currentContract.squadRevisionHash !== input.squadRevisionHash ||
        dispatchIntentVersions.includes(input.intentVersion)
      ) {
        return null;
      }
      currentMission = {
        ...currentMission,
        status: 'blocked',
        intentState: 'blocked_technical',
      };
      return currentMission;
    },
  );
  const stores = {
    scope,
    missions: {
      list: list as never,
      blockOrchestratorPreDispatchExit:
        blockOrchestratorPreDispatchExit as never,
    },
    taskDispatches: {
      list: vi.fn(() =>
        dispatchIntentVersions.map((intentVersion) => ({ intentVersion })),
      ),
    },
  };
  const deps: MissionOrchestratorExitLifecycleDeps = {
    tapExit: (tap) => {
      exitTap = tap;
      return dispose;
    },
    getStores: () => stores,
    listStores: () => [stores],
    getAgentSessionInfo: vi.fn(() => liveSession),
    readOutput: vi.fn(
      () =>
        'Preparando workers\npassword=nao-gravar\n' +
        'token sk-proj-supersecreto\núltima linha segura',
    ),
    warn: vi.fn(),
  };
  return {
    deps,
    dispose,
    list,
    blockOrchestratorPreDispatchExit,
    currentMission: () => currentMission,
    setMission: (next: Mission) => {
      currentMission = next;
    },
    setLiveSession: (next: OwnedAgentSessionInfo | null) => {
      liveSession = next;
    },
    failPersistence: (attempts = 1) => {
      persistenceFailures = attempts;
    },
    setDispatchIntentVersions: (versions: number[]) => {
      dispatchIntentVersions = [...versions];
    },
    exit: (sessionId: string, info: OwnedAgentSessionInfo | null) =>
      exitTap?.(sessionId, info),
  };
}

describe('physical Maestro exit lifecycle', () => {
  beforeEach(() => resetMissionOrchestratorExitLifecycleForTests());
  afterEach(() => resetMissionOrchestratorExitLifecycleForTests());

  it('blocks the exact accepted Maestro generation and persists only a redacted tail', () => {
    const f = fixture();

    expect(
      handleMissionOrchestratorSessionExit('orch-a', authority, f.deps),
    ).toBe(true);
    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledOnce();
    const input = f.blockOrchestratorPreDispatchExit.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      missionId: 'mission-a',
      orchestratorSessionId: 'orch-a',
      intentVersion: 2,
      intentContractHash: authority.authoritySeal?.intentContractHash,
      squadRevisionHash: authority.authoritySeal?.squadRevisionHash,
      observation: 'physical_exit',
    });
    expect(input?.outputTail).toContain('última linha segura');
    expect(input?.outputTail).not.toContain('nao-gravar');
    expect(input?.outputTail).not.toContain('supersecreto');
  });

  it('ignores workers and lets the store reject stale orchestrator seals', () => {
    const f = fixture();
    expect(
      handleMissionOrchestratorSessionExit(
        'worker-a',
        {
          ...authority,
          sessionId: 'worker-a',
          role: 'worker',
          workerIncarnationId: 'generation-a',
        },
        f.deps,
      ),
    ).toBe(false);
    expect(f.blockOrchestratorPreDispatchExit).not.toHaveBeenCalled();

    expect(
      handleMissionOrchestratorSessionExit(
        'orch-a',
        {
          ...authority,
          authoritySeal: {
            ...authority.authoritySeal!,
            intentContractHash: 'f'.repeat(64),
          },
        },
        f.deps,
      ),
    ).toBe(false);
    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledOnce();
    expect(f.currentMission().status).toBe('running');
  });

  it('blocks a replacement Maestro rearmed as running/executing', () => {
    const f = fixture();
    f.setMission({ ...mission, intentState: 'executing' });

    expect(
      handleMissionOrchestratorSessionExit('orch-a', authority, f.deps),
    ).toBe(true);
    expect(f.currentMission()).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('suppresses only an exact intentional teardown through durable cleanup', () => {
    const f = fixture();
    const release = suppressIntentionalMissionOrchestratorExit({
      scope,
      missionId: mission.id,
      orchestratorSessionId: 'orch-a',
      authoritySeal: authority.authoritySeal!,
    });

    expect(
      handleMissionOrchestratorSessionExit('orch-a', authority, f.deps),
    ).toBe(false);
    f.setLiveSession(null);
    expect(reconcileMissionOrchestratorExits(f.deps)).toBe(true);
    expect(f.blockOrchestratorPreDispatchExit).not.toHaveBeenCalled();

    release();
    expect(reconcileMissionOrchestratorExits(f.deps)).toBe(true);
    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledOnce();
    expect(f.currentMission()).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('treats diagnostic output as optional to the durable safety transition', () => {
    const f = fixture();
    vi.mocked(f.deps.readOutput).mockImplementation(() => {
      throw new Error('ring buffer unavailable');
    });

    expect(
      handleMissionOrchestratorSessionExit('orch-a', authority, f.deps),
    ).toBe(true);
    expect(
      f.blockOrchestratorPreDispatchExit.mock.calls[0]?.[0].outputTail,
    ).toContain('saída indisponível');
    expect(f.deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('blocking without it'),
      expect.objectContaining({ message: 'ring buffer unavailable' }),
    );
  });

  it('retains a tombstone and retries a transient SQLite failure', () => {
    const f = fixture();
    f.failPersistence(2);

    expect(
      handleMissionOrchestratorSessionExit('orch-a', authority, f.deps),
    ).toBe(false);
    expect(f.currentMission().status).toBe('running');

    expect(reconcileMissionOrchestratorExits(f.deps)).toBe(false);
    expect(f.currentMission().status).toBe('running');
    expect(reconcileMissionOrchestratorExits(f.deps)).toBe(true);

    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledTimes(3);
    expect(f.currentMission()).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(f.deps.warn).toHaveBeenCalledWith(
      '[mission-orchestrator-exit] durable block pending retry:',
      expect.objectContaining({ message: 'sqlite unavailable' }),
    );
  });

  it('recovers after crash/restart from a durable binding whose PTY is absent', () => {
    const f = fixture();
    f.setLiveSession(null);
    // No in-memory exit callback/tombstone exists: this is a fresh process.
    resetMissionOrchestratorExitLifecycleForTests();

    expect(reconcileMissionOrchestratorExits(f.deps)).toBe(true);

    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledOnce();
    expect(
      f.blockOrchestratorPreDispatchExit.mock.calls[0]?.[0],
    ).toMatchObject({
      missionId: mission.id,
      orchestratorSessionId: 'orch-a',
      intentVersion: 2,
      observation: 'missing_session_reconcile',
    });
    expect(f.currentMission()).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('does not infer an exit while the exact PTY is live or after a dispatch exists', () => {
    const live = fixture();
    reconcileMissionOrchestratorExits(live.deps);
    expect(live.blockOrchestratorPreDispatchExit).not.toHaveBeenCalled();

    const delegated = fixture();
    delegated.setLiveSession(null);
    delegated.setDispatchIntentVersions([2]);
    reconcileMissionOrchestratorExits(delegated.deps);
    expect(
      delegated.blockOrchestratorPreDispatchExit,
    ).not.toHaveBeenCalled();
  });

  it('wires and removes the physical-exit tap with coordinator lifecycle', () => {
    const f = fixture();
    prepareMissionOrchestratorExitLifecycle(f.deps);

    f.exit('orch-a', authority);
    expect(f.blockOrchestratorPreDispatchExit).toHaveBeenCalledOnce();

    shutdownMissionOrchestratorExitLifecycle();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
