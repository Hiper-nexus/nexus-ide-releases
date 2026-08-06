import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { compileIntentContract } from '../../shared/mission-intent';

const runtime = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  snapshots: [] as Array<Record<string, unknown>>,
  /** Live PTYs absent from every authority inventory (unattributable). */
  unattributed: [] as string[],
  terminatePty: vi.fn(async (_sessionId: string) => true),
  closeMissionPane: vi.fn(
    async (_request: {
      paneId: string;
      missionId: string;
      scope: ProjectExecutionScope;
    }) => true,
  ),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) =>
    runtime.pty.some((entry) => entry.sessionId === sessionId) ||
    runtime.unattributed.includes(sessionId)
      ? 'idle'
      : null,
  listAgentSessions: () => [...runtime.pty],
  orchTerminateSession: async (sessionId: string) => {
    const result = await runtime.terminatePty(sessionId);
    if (result) {
      runtime.pty = runtime.pty.filter(
        (entry) => entry.sessionId !== sessionId,
      );
    }
    return result;
  },
}));

vi.mock('./pane-registry', () => ({
  getPaneRuntimeAuthorityBySession: (sessionId: string) =>
    runtime.pty.find((entry) => entry.sessionId === sessionId) ?? null,
  listPaneSnapshots: () => [...runtime.snapshots],
  requestMissionPaneClose: runtime.closeMissionPane,
}));

import {
  closeOrphanedMissionRuntime,
  closeMissionRuntimePreservingHistory,
  prepareMissionRuntimeTermination,
  settleMissionRuntimeDemotion,
  terminateMissionRuntime,
  terminateUnauthorizedMissionRuntimes,
} from './mission-runtime-termination';
import { hasAutomaticTechnicalRecovery } from '../../shared/mission-recovery-policy';
import { withMissionLifecycleLock } from './mission-lifecycle-lock';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-runtime-termination',
  projectId: 'project-runtime-termination',
  checkoutId: 'checkout-runtime-termination',
  rootRealPath: '/workspace/runtime-termination',
  identitySource: 'manifest',
});

const mission = {
  id: 'mission-runtime-termination',
  title: 'Terminate every physical worker',
  description: '',
  status: 'blocked',
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 2,
} as Mission;

function authorizedMission(): Mission {
  const contract = compileIntentContract({
    goal: 'Continuar a execução aprovada',
    intentVersion: 1,
  });
  return {
    ...mission,
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 11,
    },
  };
}

function pane(
  paneId: string,
  workerIncarnationId: string,
): MissionPaneSpec {
  return {
    id: `persisted-${paneId}`,
    missionId: mission.id,
    paneId,
    adapterId: 'codex',
    title: paneId,
    agentName: paneId,
    workerIncarnationId,
    role: 'worker',
    scope,
    createdAt: 1,
  };
}

function physical(
  sessionId: string,
  paneId: string,
  workerIncarnationId: string,
) {
  return {
    sessionId,
    paneId,
    adapterId: 'codex',
    cwd: scope.rootRealPath,
    missionId: mission.id,
    role: 'worker' as const,
    workerIncarnationId,
    scope,
    kind: 'mission' as const,
  };
}

function suite(panes: MissionPaneSpec[]) {
  return {
    missions: {
      get: (missionId: string) => (missionId === mission.id ? mission : null),
      list: () => [mission],
    },
    missionPanes: {
      list: (missionId: string) => (missionId === mission.id ? panes : []),
    },
  } as never;
}

function closeSuite(
  initial: Mission,
  panes: MissionPaneSpec[],
): {
  suite: Parameters<typeof closeMissionRuntimePreservingHistory>[0]['suite'];
  current: () => Mission;
} {
  let current = initial;
  const store = {
    missions: {
      get: (missionId: string) =>
        missionId === current.id ? current : null,
      list: () => [current],
      block: (missionId: string, kind: 'user' | 'technical') => {
        if (missionId !== current.id) return null;
        current = {
          ...current,
          status: 'blocked',
          intentState:
            kind === 'user' ? 'blocked_user' : 'blocked_technical',
          updatedAt: current.updatedAt + 1,
        };
        return current;
      },
      update: (missionId: string, patch: Partial<Mission>) => {
        if (missionId !== current.id) return null;
        current = {
          ...current,
          ...patch,
          updatedAt: current.updatedAt + 1,
        };
        return current;
      },
      setOrchestratorSession: (
        missionId: string,
        sessionId: string | null,
      ) => {
        if (missionId !== current.id) return null;
        current = {
          ...current,
          orchestratorSessionId: sessionId ?? undefined,
          updatedAt: current.updatedAt + 1,
        };
        return current;
      },
    },
    missionPanes: {
      list: (missionId: string) =>
        missionId === current.id ? panes : [],
    },
  } as never;
  return { suite: store, current: () => current };
}

beforeEach(() => {
  runtime.pty = [];
  runtime.snapshots = [];
  runtime.unattributed = [];
  runtime.terminatePty.mockReset().mockResolvedValue(true);
  runtime.closeMissionPane.mockReset().mockResolvedValue(true);
});

describe('mission runtime physical inventory termination', () => {
  it('closes an orphan runtime idempotently without touching the same mission id in another scope', async () => {
    const otherScope = Object.freeze({
      ...scope,
      projectId: 'project-other-orphan',
      checkoutId: 'checkout-other-orphan',
      rootRealPath: '/workspace/other-orphan',
    });
    runtime.pty = [
      physical('pty-orphan-local', 'pane-orphan-local', 'inc-local'),
      {
        ...physical('pty-orphan-foreign', 'pane-orphan-foreign', 'inc-foreign'),
        scope: otherScope,
      },
    ];
    runtime.snapshots = [
      {
        paneId: 'pane-orphan-local',
        sessionId: 'pty-orphan-local',
        missionId: mission.id,
        role: 'worker',
        scope,
      },
      {
        paneId: 'pane-orphan-foreign',
        sessionId: 'pty-orphan-foreign',
        missionId: mission.id,
        role: 'worker',
        scope: otherScope,
      },
    ];

    await expect(
      closeOrphanedMissionRuntime({
        scope,
        missionId: mission.id,
      }),
    ).resolves.toEqual({
      ok: true,
      terminatedSessionIds: ['pty-orphan-local'],
    });
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-orphan-local');
    expect(runtime.terminatePty).not.toHaveBeenCalledWith('pty-orphan-foreign');
    expect(runtime.closeMissionPane).toHaveBeenCalledWith({
      paneId: 'pane-orphan-local',
      missionId: mission.id,
      scope,
    });
    expect(runtime.closeMissionPane).not.toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-orphan-foreign' }),
    );

    runtime.closeMissionPane.mockClear();
    await expect(
      closeOrphanedMissionRuntime({
        scope,
        missionId: mission.id,
      }),
    ).resolves.toEqual({
      ok: true,
      terminatedSessionIds: [],
    });
    expect(runtime.terminatePty).toHaveBeenCalledTimes(1);
  });

  it('finds and terminates a detached PTY absent from renderer snapshots', async () => {
    runtime.pty = [physical('pty-hidden', 'pane-hidden', 'inc-hidden')];
    const stores = suite([pane('pane-hidden', 'inc-hidden')]);

    expect(
      prepareMissionRuntimeTermination({
        scope,
        suite: stores,
        missionId: mission.id,
        reason: 'authority-revoked',
      }).sessionIds,
    ).toEqual(['pty-hidden']);
    await expect(
      terminateMissionRuntime({
        scope,
        suite: stores,
        missionId: mission.id,
        reason: 'authority-revoked',
        collapsePanes: true,
      }),
    ).resolves.toMatchObject({ ok: true, terminatedSessionIds: ['pty-hidden'] });
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-hidden');
    expect(runtime.closeMissionPane).not.toHaveBeenCalled();
  });

  it('keeps exclusivity and pane authority when descendant exit is unproven', async () => {
    runtime.pty = [physical('pty-daemon', 'pane-daemon', 'inc-daemon')];
    runtime.snapshots = [{
      paneId: 'pane-daemon',
      sessionId: 'pty-daemon',
      title: 'Daemon worker',
      kind: 'cli-agent',
      state: 'idle',
      missionId: mission.id,
      role: 'worker',
      scope,
    }];
    runtime.terminatePty.mockResolvedValueOnce(false);

    const result = await terminateMissionRuntime({
      scope,
      suite: suite([pane('pane-daemon', 'inc-daemon')]),
      missionId: mission.id,
      reason: 'authority-revoked',
      collapsePanes: true,
    });

    expect(result).toMatchObject({
      ok: false,
      terminatedSessionIds: [],
      error: expect.stringMatching(/physical exit proof|replacement remains denied/i),
    });
    expect(runtime.pty).toHaveLength(1);
    expect(runtime.closeMissionPane).not.toHaveBeenCalled();
  });

  it('kills a mission-bound physical orphan whose incarnation has no exact persisted spec', async () => {
    runtime.pty = [physical('pty-orphan', 'pane-orphan', 'inc-new')];
    const stores = suite([pane('pane-orphan', 'inc-old')]);

    expect(
      prepareMissionRuntimeTermination({
        scope,
        suite: stores,
        missionId: mission.id,
        reason: 'authority-revoked',
      }).sessionIds,
    ).toEqual(['pty-orphan']);
    await terminateMissionRuntime({
      scope,
      suite: stores,
      missionId: mission.id,
      reason: 'authority-revoked',
    });
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-orphan');
  });

  it('rescans after physical exit and terminates a late replacement', async () => {
    runtime.pty = [physical('pty-first', 'pane-late', 'inc-late')];
    runtime.terminatePty.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'pty-first') {
        runtime.pty.push(physical('pty-late', 'pane-late', 'inc-late'));
      }
      return true;
    });
    const stores = suite([pane('pane-late', 'inc-late')]);

    await expect(
      terminateMissionRuntime({
        scope,
        suite: stores,
        missionId: mission.id,
        reason: 'authority-revoked',
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: ['pty-first', 'pty-late'],
    });
    expect(runtime.terminatePty).toHaveBeenCalledTimes(2);
  });

  it('never terminates a same-id mission runtime bound to another project scope', async () => {
    const otherScope = Object.freeze({
      ...scope,
      projectId: 'project-other',
      checkoutId: 'checkout-other',
      rootRealPath: '/workspace/other',
    });
    runtime.pty = [
      physical('pty-local', 'pane-local', 'inc-local'),
      {
        ...physical('pty-other', 'pane-other', 'inc-other'),
        scope: otherScope,
      },
    ];
    const stores = suite([pane('pane-local', 'inc-local')]);

    await expect(
      terminateMissionRuntime({
        scope,
        suite: stores,
        missionId: mission.id,
        reason: 'authority-revoked',
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: ['pty-local'],
    });
    expect(runtime.terminatePty).not.toHaveBeenCalledWith('pty-other');
  });

  it('does not collapse a homonymous renderer pane from another checkout', async () => {
    const otherScope = Object.freeze({
      ...scope,
      projectId: 'project-other-pane',
      checkoutId: 'checkout-other-pane',
      rootRealPath: '/workspace/other-pane',
    });
    runtime.pty = [physical('pty-local', 'pane-shared', 'inc-local')];
    runtime.snapshots = [
      {
        paneId: 'pane-shared',
        sessionId: null,
        title: 'Foreign',
        kind: 'cli-agent',
        state: 'idle',
        missionId: mission.id,
        role: 'worker',
        scope: otherScope,
      },
    ];

    await expect(
      terminateMissionRuntime({
        scope,
        suite: suite([pane('pane-shared', 'inc-local')]),
        missionId: mission.id,
        reason: 'authority-revoked',
        collapsePanes: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: ['pty-local'],
    });
    expect(runtime.closeMissionPane).not.toHaveBeenCalled();
  });

  it('passes scope and mission authority into a visual pane collapse', async () => {
    runtime.pty = [physical('pty-local', 'pane-local', 'inc-local')];
    runtime.snapshots = [
      {
        paneId: 'pane-local',
        sessionId: 'pty-local',
        title: 'Local',
        kind: 'cli-agent',
        state: 'idle',
        missionId: mission.id,
        role: 'worker',
        scope,
      },
    ];

    await terminateMissionRuntime({
      scope,
      suite: suite([pane('pane-local', 'inc-local')]),
      missionId: mission.id,
      reason: 'authority-revoked',
      collapsePanes: true,
    });

    expect(runtime.closeMissionPane).toHaveBeenCalledWith({
      paneId: 'pane-local',
      missionId: mission.id,
      scope,
    });
  });

  it('preserves a user stop while teardown proof remains pending', async () => {
    let current: Mission = {
      ...mission,
      description: 'Bloqueio solicitado pelo operador.',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-daemon',
    };
    const persistedPane = pane('pane-daemon', 'inc-daemon');
    runtime.pty = [physical('pty-daemon', 'pane-daemon', 'inc-daemon')];
    runtime.terminatePty.mockResolvedValueOnce(false);
    const stores = {
      missions: {
        get: (missionId: string) =>
          missionId === current.id ? current : null,
        list: () => [current],
        update: (missionId: string, patch: Partial<Mission>) => {
          if (missionId !== current.id) return null;
          current = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          return current;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === current.id ? [persistedPane] : [],
      },
    } as never;

    const result = await settleMissionRuntimeDemotion({
      scope,
      suite: stores,
      demotedMission: current,
    });

    expect(result.termination.ok).toBe(false);
    expect(result.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-daemon',
    });
    expect(result.mission.description).toMatch(/encerramento físico.*pendente/i);
    expect(runtime.pty).toHaveLength(1);
    expect(runtime.closeMissionPane).not.toHaveBeenCalled();
  });
});

describe('demoção preserva os panes — o operador continua no controle (06/08)', () => {
  it('encerra as sessões físicas SEM colapsar os panes da missão', async () => {
    // Voo real 06/08: "execução encerrada pelo operador" colapsava todos os
    // panes; fechar o último pane invoca o HomeDeck (layout-store) e o
    // operador era EJETADO para "O que você quer criar?" com o scrollback
    // perdido. Doutrina do próprio layout-store: preservar transcript de
    // missão morta se resolve NÃO fechando o pane.
    let current: Mission = {
      ...mission,
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-preserve',
    };
    runtime.pty = [
      {
        sessionId: 'pty-preserve',
        paneId: 'pane-preserve',
        missionId: mission.id,
        workerIncarnationId: 'inc-preserve',
        role: 'orchestrator',
        scope,
      },
    ];
    runtime.snapshots = [
      {
        paneId: 'pane-preserve',
        sessionId: 'pty-preserve',
        title: 'Maestro',
        kind: 'cli-agent',
        state: 'idle',
        missionId: mission.id,
        role: 'orchestrator',
        scope,
      },
    ];
    const stores = {
      missions: {
        get: (missionId: string) =>
          missionId === current.id ? current : null,
        list: () => [current],
        update: (missionId: string, patch: Partial<Mission>) => {
          if (missionId !== current.id) return null;
          current = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          return current;
        },
        setOrchestratorSession: (missionId: string, value: string | null) => {
          if (missionId !== current.id) return null;
          current = {
            ...current,
            orchestratorSessionId: value ?? undefined,
          };
          return current;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === current.id
            ? [pane('pane-preserve', 'inc-preserve')]
            : [],
      },
    } as never;

    const result = await settleMissionRuntimeDemotion({
      scope,
      suite: stores,
      demotedMission: current,
    });

    expect(result.termination.ok).toBe(true);
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-preserve');
    // O pane fica: scrollback e controle permanecem com o operador; o card da
    // missão diz o porquê e oferece Retomar.
    expect(runtime.closeMissionPane).not.toHaveBeenCalled();
  });
});

describe('unauthorized runtime reconciliation lifecycle lock', () => {
  it('does not terminate when an approved resume wins the mission lock', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_technical',
    };
    let current = blocked;
    const persisted = pane('pane-resume-wins', 'inc-resume-wins');
    runtime.pty = [
      physical('pty-resume-wins', 'pane-resume-wins', 'inc-resume-wins'),
    ];
    const stores = {
      missions: {
        // Deliberately stale wake-up snapshot.
        list: () => [blocked],
        get: (missionId: string) =>
          missionId === current.id ? current : null,
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === current.id ? [persisted] : [],
      },
    } as never;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let resumeEntered!: () => void;
    const resumeEnteredGate = new Promise<void>((resolve) => {
      resumeEntered = resolve;
    });
    const resume = withMissionLifecycleLock(scope, mission.id, async () => {
      current = authorizedMission();
      resumeEntered();
      await resumeGate;
    });
    await resumeEnteredGate;

    const reconcile = terminateUnauthorizedMissionRuntimes(scope, stores);
    releaseResume();
    await resume;

    await expect(reconcile).resolves.toEqual([]);
    expect(runtime.terminatePty).not.toHaveBeenCalled();
    expect(runtime.pty).toHaveLength(1);
  });

  it('makes resume wait for teardown and then start exactly once', async () => {
    let current: Mission = {
      ...mission,
      intentState: 'blocked_technical',
    };
    const persisted = pane('pane-reconcile-wins', 'inc-reconcile-wins');
    runtime.pty = [
      physical(
        'pty-reconcile-wins',
        'pane-reconcile-wins',
        'inc-reconcile-wins',
      ),
    ];
    const stores = {
      missions: {
        list: () => [current],
        get: (missionId: string) =>
          missionId === current.id ? current : null,
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === current.id ? [persisted] : [],
      },
    } as never;
    const effects: string[] = [];
    let releaseTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminationEntered!: () => void;
    const terminationEnteredGate = new Promise<void>((resolve) => {
      terminationEntered = resolve;
    });
    runtime.terminatePty.mockImplementation(async () => {
      effects.push('terminate:start');
      terminationEntered();
      await terminationGate;
      effects.push('terminate:end');
      return true;
    });

    const reconcile = terminateUnauthorizedMissionRuntimes(scope, stores);
    await terminationEnteredGate;
    const resume = withMissionLifecycleLock(scope, mission.id, () => {
      effects.push('spawn');
      current = authorizedMission();
    });
    releaseTermination();
    const [results] = await Promise.all([reconcile, resume]);

    expect(results).toEqual([
      {
        ok: true,
        terminatedSessionIds: ['pty-reconcile-wins'],
      },
    ]);
    expect(effects).toEqual(['terminate:start', 'terminate:end', 'spawn']);
    expect(runtime.terminatePty).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });
});

describe('operator close preserves durable mission history', () => {
  it('revoga a recuperação automática mesmo quando nenhum PTY está vivo', async () => {
    const recovering: Mission = {
      ...mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      intentVersion: 1,
      intentContract: {
        goal: 'Recuperar missão sem apagar histórico',
        intentVersion: 1,
        approvedAt: 1,
      } as Mission['intentContract'],
      orchestratorSessionId: undefined,
    };
    const stores = closeSuite(recovering, []);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: recovering.id,
    });

    expect(result).toMatchObject({
      ok: true,
      terminatedSessionIds: [],
      mission: {
        id: recovering.id,
        status: 'blocked',
        intentState: 'blocked_user',
      },
    });
    expect(stores.current()).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
  });

  it('closes an already-blocked mission runtime and clears its session binding', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-blocked',
    };
    const persisted = pane('pane-blocked', 'inc-blocked');
    runtime.pty = [
      physical('pty-blocked', 'pane-blocked', 'inc-blocked'),
    ];
    const stores = closeSuite(blocked, [persisted]);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: blocked.id,
    });

    expect(result).toMatchObject({
      ok: true,
      terminatedSessionIds: ['pty-blocked'],
      mission: {
        id: blocked.id,
        status: 'blocked',
        intentState: 'blocked_user',
        orchestratorSessionId: undefined,
      },
    });
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-blocked');
    expect(stores.current().id).toBe(blocked.id);
  });

  it('demotes a running mission before terminating its physical runtime', async () => {
    const running: Mission = {
      ...mission,
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: 'pty-running',
    };
    const persisted = pane('pane-running', 'inc-running');
    runtime.pty = [
      physical('pty-running', 'pane-running', 'inc-running'),
    ];
    const stores = closeSuite(running, [persisted]);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: running.id,
    });

    expect(result).toMatchObject({
      ok: true,
      mission: {
        status: 'blocked',
        intentState: 'blocked_user',
        orchestratorSessionId: undefined,
      },
    });
  });

  it('is idempotent when the runtime is already physically absent', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: undefined,
    };
    const stores = closeSuite(blocked, [pane('pane-dead', 'inc-dead')]);

    await expect(
      closeMissionRuntimePreservingHistory({
        scope,
        suite: stores.suite,
        missionId: blocked.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: [],
      mission: { id: blocked.id, status: 'blocked' },
    });
  });

  it('nunca reporta encerramento limpo sobre sessão viva sem autoridade de pane', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-ghost-live',
    };
    // Ponteiro durável da missão aponta para um processo VIVO que nenhuma
    // autoridade de pane consegue atribuir (registro perdido/recarga do
    // renderer). Encerrar aqui mataria o ponteiro e deixaria o processo órfão.
    runtime.unattributed = ['pty-ghost-live'];
    const stores = closeSuite(blocked, []);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: blocked.id,
    });

    expect(result).toMatchObject({
      ok: false,
      terminatedSessionIds: [],
      mission: {
        intentState: 'blocked_user',
        orchestratorSessionId: 'pty-ghost-live',
      },
    });
    expect(result.ok ? '' : result.error).toMatch(
      /live without pane authority/i,
    );
    expect(runtime.terminatePty).not.toHaveBeenCalled();
  });

  it('encerra limpo quando o ponteiro durável aponta para processo já morto', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-already-dead',
    };
    const stores = closeSuite(blocked, []);

    await expect(
      closeMissionRuntimePreservingHistory({
        scope,
        suite: stores.suite,
        missionId: blocked.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: [],
      mission: { orchestratorSessionId: undefined },
    });
  });

  it('nega encerramento quando worker vivo da missão não tem pane vinculado', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: undefined,
    };
    const headless = physical('pty-headless', 'pane-headless', 'inc-headless');
    delete (headless as { paneId?: string }).paneId;
    runtime.pty = [headless];
    const stores = closeSuite(blocked, []);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: blocked.id,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/without a pane binding/i);
    expect(runtime.terminatePty).not.toHaveBeenCalled();
  });

  it('keeps the binding and user stop when exit proof fails', async () => {
    const blocked: Mission = {
      ...mission,
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-stuck',
    };
    const persisted = pane('pane-stuck', 'inc-stuck');
    runtime.pty = [physical('pty-stuck', 'pane-stuck', 'inc-stuck')];
    runtime.terminatePty.mockResolvedValueOnce(false);
    const stores = closeSuite(blocked, [persisted]);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: blocked.id,
    });

    expect(result).toMatchObject({
      ok: false,
      terminatedSessionIds: [],
      mission: {
        status: 'blocked',
        intentState: 'blocked_user',
        orchestratorSessionId: 'pty-stuck',
        description: expect.stringMatching(/encerramento físico.*pendente/i),
      },
    });
  });

  it('never turns a failed mission into automatic recovery when exit proof fails', async () => {
    const failed: Mission = {
      ...mission,
      status: 'failed',
      intentState: 'blocked_technical',
      intentVersion: 1,
      intentContract: {
        goal: 'Missão que já falhou',
        intentVersion: 1,
        approvedAt: 1,
      } as Mission['intentContract'],
      orchestratorSessionId: 'pty-failed',
    };
    const persisted = pane('pane-failed', 'inc-failed');
    runtime.pty = [physical('pty-failed', 'pane-failed', 'inc-failed')];
    runtime.terminatePty.mockResolvedValueOnce(false);
    const stores = closeSuite(failed, [persisted]);

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite: stores.suite,
      missionId: failed.id,
    });

    expect(result).toMatchObject({
      ok: false,
      mission: {
        status: 'failed',
        orchestratorSessionId: 'pty-failed',
        description: expect.stringMatching(/encerramento físico.*pendente/i),
      },
    });
    if (!result.mission) throw new Error('mission result expected');
    expect(hasAutomaticTechnicalRecovery(result.mission)).toBe(false);
  });
});
