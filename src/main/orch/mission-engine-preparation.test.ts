import { describe, expect, it, vi } from 'vitest';
import type {
  MissionAttachmentSnapshot,
  MissionIntentContract,
  MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { Mission, Squad } from '../../shared/orch-types';
import type { MissionPrepareRequest } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import { MainMissionEngine, type MainMissionEnginePorts } from './mission-engine';
import {
  createMissionEnginePreparationPorts,
  rosterIdentityMatches,
} from './mission-engine-preparation';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';

vi.mock('./intent-router', () => ({ routeIntent: vi.fn(async () => null) }));

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

const request: MissionPrepareRequest = {
  title: 'Corrigir o checkout',
  objective: 'Corrija o total do checkout e prove o resultado.',
  contextPaths: ['src/checkout.ts', 'src/checkout.test.ts'],
  acceptanceCriteria: [
    'O total corrigido possui evidência verificável no checkout.',
  ],
  roster: [
    {
      id: 'mission-coordinator',
      agentName: 'Coordenar e revisar',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['nexus_task'],
      allowedSkills: [],
    },
    {
      id: 'checkout-worker',
      agentName: 'Implementar checkout',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: [],
    },
    {
      id: 'checkout-reviewer',
      agentName: 'Revisar checkout',
      category: 'reviewer',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read'],
      allowedSkills: [],
    },
  ],
  advanced: { lane: 'standard' },
};

const runtimeSquad: Squad = {
  id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174000',
  name: 'Equipe — Corrigir o checkout',
  createdAt: '100',
  builtin: false,
  runtimeSourceSquadId: 'custom-mission-setup-source',
  runtimeSourceSquadRevisionHash: 'a'.repeat(64),
  orchestratorInstructions: 'Coordene a missão aprovada pelo Nexus.',
  agents: request.roster.map((agent) => ({ ...agent })),
};

const runtime: MissionOrchestratorRuntimeSnapshot = {
  adapterId: 'codex',
  model: 'gpt-5.6-sol',
  accountId: 'account-codex',
  readOnly: false,
  nativeReadOnly: true,
};

const sealedScreenshot: MissionAttachmentSnapshot = {
  path: '/sealed/checkout-a/print.png',
  sourcePath: '/workspace/a/.nexus/attachments/mission-context/print.png',
  sha256: 'b'.repeat(64),
  size: 5,
  sealId: 'c'.repeat(32),
  device: '10',
  inode: '20',
};

function createStoreHarness() {
  let mission: Mission | null = null;
  const create = vi.fn((input: {
    title: string;
    description?: string;
    squadId?: string;
    intentState?: Mission['intentState'];
    intentContract?: MissionIntentContract;
    intentVersion?: number;
  }) => {
    mission = {
      id: 'mission-prepared',
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      squadId: input.squadId,
      milestones: [],
      learnings: '',
      intentState: input.intentState,
      intentContract: input.intentContract,
      intentVersion: input.intentVersion ?? 0,
      createdAt: 100,
      updatedAt: 100,
    };
    return mission;
  });
  const get = vi.fn((missionId: string) =>
    mission?.id === missionId ? mission : null,
  );
  const bindMissionRuntimeSquad = vi.fn(
    (
      missionId: string,
      expected: Mission,
      squadId: string,
      contract?: MissionIntentContract,
    ) => {
      if (!mission || mission.id !== missionId || mission !== expected) {
        throw new Error('mission preparation CAS changed');
      }
      mission = {
        ...mission,
        squadId,
        intentContract: contract ?? mission.intentContract,
        updatedAt: mission.updatedAt + 1,
      };
      return mission;
    },
  );
  const removeIfUnchanged = vi.fn(
    (missionId: string, expected: Readonly<Mission>) => {
      if (!mission || mission.id !== missionId) return 'missing' as const;
      if (mission !== expected) return 'changed' as const;
      mission = null;
      return 'removed' as const;
    },
  );
  return {
    missions: { create, get, bindMissionRuntimeSquad, removeIfUnchanged },
    current: () => mission,
  };
}

function createCleanupHarness() {
  const store = createStoreHarness();
  const discardRuntimeSquad = vi.fn(() => true);
  const preparation = createMissionEnginePreparationPorts({
    scope,
    missions: store.missions,
    deps: {
      now: () => 200,
      persistRuntimeSquad: () => runtimeSquad,
      getSquad: (id) => (id === runtimeSquad.id ? runtimeSquad : null),
      resolveRuntime: () => runtime,
      discardRuntimeSquad,
    },
  });
  return { store, preparation, discardRuntimeSquad };
}

function createRoutingHarness(
  routeIntent: (objective: string) => Promise<unknown>,
  squad: Squad = runtimeSquad,
) {
  const store = createStoreHarness();
  const persistRuntimeSquad = vi.fn(() => squad);
  const preparation = createMissionEnginePreparationPorts({
    scope,
    missions: store.missions,
    deps: {
      routeIntent,
      now: () => 200,
      persistRuntimeSquad,
      getSquad: () => squad,
      resolveRuntime: () => runtime,
      discardRuntimeSquad: () => true,
      sealPetStudioImage: () => sealedScreenshot,
    },
  });
  const engine = new MainMissionEngine(scope, {
    ...preparation,
    readReviewFence: async () => null,
    seal: async () => undefined,
    bootstrap: async () => undefined,
    retryKickoff: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    direct: async () => undefined,
    answerQuestion: async () => undefined,
    blockUser: () => undefined,
    blockTechnical: () => undefined,
    resumeTechnical: () => undefined,
    completeVerified: () => undefined,
    readSnapshotView: async () => { throw new Error('unused'); },
    listSnapshotViews: async () => [],
  });
  return { store, preparation, engine, persistRuntimeSquad };
}

describe('mission routing before approval', () => {
  it('does not persist a squad or mission when the renderer changes project during routing', async () => {
    let finishRouting!: (route: unknown) => void;
    let isCurrent = true;
    const { engine, store, persistRuntimeSquad } = createRoutingHarness(() => new Promise(resolve => { finishRouting = resolve; }));
    const pending = engine.prepare(scope, request, () => {
      if (!isCurrent) throw new Error('renderer workspace changed');
    });
    const persistedBeforeReply = persistRuntimeSquad.mock.calls.length;
    isCurrent = false;
    finishRouting({ kind: 'mission-work', skills: [] });
    await expect(pending).rejects.toThrow('renderer workspace changed');
    expect(persistedBeforeReply).toBe(0);
    expect(persistRuntimeSquad).not.toHaveBeenCalled();
    expect(store.current()).toBeNull();
  });

  it('persists the routed question and includes it in the immutable review without changing authority', async () => {
    const routed = {
      kind: 'mission-question',
      question: 'Qual é o problema no total do checkout?',
      readOnlyWorkers: true,
    };
    const first = createRoutingHarness(async () => routed);
    const review = await first.engine.prepare(scope, request);

    expect(first.store.current()?.intentContract).toMatchObject({
      goal: request.objective,
      lane: 'standard',
      budgets: { maxWorkers: 64 },
      routingAdvice: { source: 'router', ...routed },
      approvalReviewSha256: review.reviewSha256,
    });
    expect(review.objective).toBe(request.objective);
    expect(review.roster).toEqual(runtimeSquad.agents);
    expect(review.permissions.map(({ id }) => id)).toContain('workspace-write');
    expect(review.warnings.join('\n')).toContain(routed.question);
    const second = createRoutingHarness(async () => ({
      ...routed, question: 'Qual teste reproduz o problema?',
    }));
    const secondReview = await second.engine.prepare(scope, request);
    expect(secondReview.reviewSha256).not.toBe(review.reviewSha256);
  });

  it('waits for routing before creating the reviewable mission', async () => {
    let finishRouting!: (route: unknown) => void;
    let classifiedObjective: string | undefined;
    const { store, preparation } = createRoutingHarness((objective) => {
      classifiedObjective = objective;
      return new Promise((resolve) => { finishRouting = resolve; });
    });
    const armed = preparation.arm(request);
    expect(store.current()).toBeNull();
    finishRouting({ kind: 'mission-work', skills: [] });
    await armed;
    expect(classifiedObjective).toBe(request.objective);
    expect(store.current()?.intentContract?.routingAdvice).toEqual({
      source: 'router', kind: 'mission-work', skills: [],
    });
  });

  it('keeps only known skill suggestions already allowed by the prepared squad', async () => {
    const squad: Squad = {
      ...runtimeSquad,
      agents: runtimeSquad.agents.map((agent) => ({
        ...agent, allowedSkills: ['bridgesecurity'],
      })),
    };
    const { store, engine } = createRoutingHarness(async () => ({
      kind: 'mission-work',
      skills: ['impeccable', 'bridgesecurity', 'arbitrary-command', 'bridgesecurity'],
    }), squad);
    const review = await engine.prepare(scope, request);

    expect(store.current()?.intentContract?.routingAdvice).toEqual({
      source: 'router', kind: 'mission-work', skills: ['bridgesecurity'],
    });
    expect(review.roster).toEqual(squad.agents);
    expect(review.warnings.join('\n')).toContain('bridgesecurity');
    expect(review.warnings.join('\n')).not.toContain('impeccable');
  });

  it.each([
    ['unavailable', async (): Promise<unknown> => null],
    ['invalid-result', async () => ({ kind: 'mission-question', question: '', readOnlyWorkers: false })],
    ['invalid-result', async () => ({ kind: 'mission-work', skills: [], lane: 'ops', allowedTools: null })],
    ['router-error', async () => { throw new Error('provider credential must not leak'); }],
  ] as const)('keeps deterministic preparation visible when routing gives %s', async (reason, routeIntent) => {
    const { store, engine } = createRoutingHarness(routeIntent);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const review = await engine.prepare(scope, request).finally(() => warn.mockRestore());

    expect(store.current()?.intentContract?.routingAdvice).toEqual({
      source: 'deterministic-fallback', kind: 'mission-work', reason,
    });
    expect(review.warnings.join('\n')).toContain('regras locais');
    expect(review.warnings.join('\n')).not.toContain('credential');
    expect(review.objective).toBe(request.objective);
    expect(review.roster).toEqual(runtimeSquad.agents);
    expect(store.current()?.intentContract?.lane).toBe('standard');
  });

  it.each(['consult', 'plan', 'ops'] as const)('preserves the explicit %s lane and free-agent choice after classification', async (lane) => {
    const selectedRequest = { ...request, advanced: { lane, freeAgentChoice: false } };
    const baseline = createRoutingHarness(async () => null);
    const baselineReview = await baseline.engine.prepare(scope, selectedRequest);
    const routed = createRoutingHarness(async () => ({
      kind: 'mission-question', question: 'Qual é o estado atual?', readOnlyWorkers: true,
    }));
    const review = await routed.engine.prepare(scope, selectedRequest);
    const baselineContract = baseline.store.current()!.intentContract!;
    const routedContract = routed.store.current()!.intentContract!;

    expect(routedContract.lane).toBe(lane);
    expect(routedContract.freeAgentChoice).toBe(baselineContract.freeAgentChoice);
    expect(routedContract.budgets).toEqual(baselineContract.budgets);
    expect(routedContract.deniedTools).toEqual(baselineContract.deniedTools);
    expect(review.permissions).toEqual(baselineReview.permissions);
    expect(review.roster).toEqual(baselineReview.roster);
  });

  it('skips routing for Pet Studio and keeps its reviewed single-session contract', async () => {
    const routeIntent = vi.fn(async () => {
      throw new Error('Pet Studio must not call the router');
    });
    const { store, engine } = createRoutingHarness(routeIntent, structuredClone(PET_STUDIO_SQUAD));
    const review = await engine.prepare(scope, {
      ...request,
      profile: { kind: 'pet-studio', referenceImagePath: sealedScreenshot.sourcePath! },
    });

    expect(store.current()?.intentContract?.routingAdvice).toBeUndefined();
    expect(store.current()?.intentContract?.budgets.maxWorkers).toBe(0);
    expect(review.roster).toEqual(PET_STUDIO_SQUAD.agents);
    expect(review.warnings).toEqual(['A execução permanece em uma única sessão, sem delegação.']);
    expect(routeIntent).not.toHaveBeenCalled();
  });
});

describe('production MissionEngine preparation ports', () => {
  it('prepares, fences, and starts a real persisted mission without placeholder ports', async () => {
    const store = createStoreHarness();
    const persistRuntimeSquad = vi.fn(() => runtimeSquad);
    const resolveRuntime = vi.fn(() => runtime);
    const discardRuntimeSquad = vi.fn(() => true);
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad,
        getSquad: (id) => (id === runtimeSquad.id ? runtimeSquad : null),
        resolveRuntime,
        discardRuntimeSquad,
      },
    });
    const seal = vi.fn(async () => undefined);
    const bootstrap = vi.fn(async () => undefined);

    const ports: MainMissionEnginePorts = {
      ...preparation,
      readReviewFence: async (missionId) => {
        const reviewSha256 = store.current()?.intentContract?.approvalReviewSha256;
        return reviewSha256 ? { missionId, reviewSha256 } : null;
      },
      seal,
      bootstrap,
      retryKickoff: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      direct: async () => undefined,
      answerQuestion: async () => undefined,
      blockUser: () => undefined,
      blockTechnical: () => undefined,
      resumeTechnical: () => undefined,
      completeVerified: () => undefined,
      readSnapshotView: async (missionId) => ({
        mission: {
          id: missionId,
          title: request.title!,
          objective: request.objective,
          workspaceLabel: 'project-a/checkout-a',
          status: 'pending',
          version: 1,
          updatedAt: store.current()!.updatedAt,
        },
        hasDispatchAuthority: true,
        hasCurrentKickoffReceipt: true,
        orchestratorLive: true,
        tasks: [],
        handoffs: [],
        panes: [],
        roster: runtimeSquad.agents,
      }),
      listSnapshotViews: async () => [],
    };
    const engine = new MainMissionEngine(scope, ports);

    const review = await engine.prepare(scope, request);

    expect(review).toMatchObject({
      missionId: 'mission-prepared',
      title: request.title,
      objective: request.objective,
      workspaceLabel: '/workspace/a',
      contextPaths: request.contextPaths,
      acceptanceCriteria: request.acceptanceCriteria,
      roster: runtimeSquad.agents,
    });
    expect(review.permissions.map((permission) => permission.id)).toContain(
      'workspace-write',
    );
    expect(review.reviewSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(persistRuntimeSquad).toHaveBeenCalledOnce();
    expect(resolveRuntime).toHaveBeenCalled();
    expect(store.current()).toMatchObject({
      status: 'pending',
      intentState: 'ready_to_start',
      squadId: runtimeSquad.id,
      intentVersion: 1,
      intentContract: {
        goal: request.objective,
        lane: 'standard',
        contextPaths: request.contextPaths,
        acceptanceCriteria: request.acceptanceCriteria,
        approvedAt: 200,
        approvalReviewSha256: review.reviewSha256,
        squadRevisionHash: snapshotSquadAuthority(runtimeSquad).hash,
        orchestratorRuntime: runtime,
      },
    });

    const snapshot = await engine.start(scope, {
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });

    expect(seal).toHaveBeenCalledWith({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    expect(bootstrap).toHaveBeenCalledWith(review.missionId);
    expect(discardRuntimeSquad).not.toHaveBeenCalled();
    expect(snapshot.id).toBe(review.missionId);
  });

  it('seals wizard mission-context attachments into the review and persisted contract', async () => {
    const store = createStoreHarness();
    const sealMissionContextAttachment = vi.fn(() => sealedScreenshot);
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad: () => runtimeSquad,
        getSquad: (id) => (id === runtimeSquad.id ? runtimeSquad : null),
        resolveRuntime: () => runtime,
        discardRuntimeSquad: () => true,
        sealMissionContextAttachment,
      },
    });
    const engine = new MainMissionEngine(scope, {
      ...preparation,
      readReviewFence: async (missionId) => {
        const reviewSha256 =
          store.current()?.intentContract?.approvalReviewSha256;
        return reviewSha256 ? { missionId, reviewSha256 } : null;
      },
      seal: async () => undefined,
      bootstrap: async () => undefined,
      retryKickoff: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      direct: async () => undefined,
      answerQuestion: async () => undefined,
      blockUser: () => undefined,
      blockTechnical: () => undefined,
      resumeTechnical: () => undefined,
      completeVerified: () => undefined,
      readSnapshotView: async (missionId) => ({
        mission: {
          id: missionId,
          title: request.title!,
          objective: request.objective,
          workspaceLabel: 'project-a/checkout-a',
          status: 'pending',
          version: 1,
          updatedAt: store.current()!.updatedAt,
        },
        hasDispatchAuthority: true,
        hasCurrentKickoffReceipt: true,
        orchestratorLive: true,
        tasks: [],
        handoffs: [],
        panes: [],
        roster: runtimeSquad.agents,
      }),
      listSnapshotViews: async () => [],
    });
    const requestWithImage = {
      ...request,
      contextPaths: [
        ...request.contextPaths,
        '.nexus/attachments/mission-context/print.png',
      ],
    };

    const review = await engine.prepare(scope, requestWithImage);

    expect(sealMissionContextAttachment).toHaveBeenCalledWith(
      scope,
      '.nexus/attachments/mission-context/print.png',
    );
    expect(review.attachments).toEqual([sealedScreenshot]);
    expect(store.current()?.intentContract).toMatchObject({
      contextPaths: requestWithImage.contextPaths,
      attachmentPaths: [sealedScreenshot.path],
      attachmentSnapshots: [sealedScreenshot],
    });
  });

  it('rejects a roster without one unique coordinator before writing a mission', async () => {
    const store = createStoreHarness();
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad: () => runtimeSquad,
        getSquad: () => runtimeSquad,
        resolveRuntime: () => runtime,
        discardRuntimeSquad: () => true,
      },
    });

    await expect(
      preparation.arm({
        ...request,
        roster: request.roster.map((agent) =>
          agent.category === 'orchestrator'
            ? { ...agent, category: 'executor' as const }
            : agent,
        ),
      }),
    ).rejects.toThrow(/coordenador|orchestrator/i);
    expect(store.missions.create).not.toHaveBeenCalled();
  });

  it.each([
    { lane: 'consult' as const, allowedTool: 'Edit' },
    { lane: 'consult' as const, allowedTool: 'Bash' },
    { lane: 'plan' as const, allowedTool: 'Edit' },
    { lane: 'plan' as const, allowedTool: 'Bash' },
  ])(
    'accepts a $lane roster with $allowedTool grants',
    async ({ lane, allowedTool }) => {
      const store = createStoreHarness();
      const persistRuntimeSquad = vi.fn(() => runtimeSquad);
      const preparation = createMissionEnginePreparationPorts({
        scope,
        missions: store.missions,
        deps: {
          now: () => 200,
          persistRuntimeSquad,
          getSquad: () => runtimeSquad,
          resolveRuntime: () => runtime,
          discardRuntimeSquad: () => true,
        },
      });
      const requestWithLane: MissionPrepareRequest = {
        ...request,
        advanced: { lane },
        roster: request.roster.map((agent, index) => ({
          ...agent,
          allowedTools:
            index === 0 ? ['Read'] : ['Read', allowedTool],
        })),
      };

      const armed = await preparation.arm(requestWithLane);
      expect(armed.missionId).toBeDefined();
      expect(persistRuntimeSquad).toHaveBeenCalled();
      expect(store.missions.create).toHaveBeenCalled();
    },
  );
  it('discards the runtime squad when mission creation fails', async () => {
    const store = createStoreHarness();
    const discardRuntimeSquad = vi.fn(() => true);
    store.missions.create.mockImplementationOnce(() => {
      throw new Error('mission insert failed');
    });
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad: () => runtimeSquad,
        getSquad: () => runtimeSquad,
        resolveRuntime: () => runtime,
        discardRuntimeSquad,
      },
    });

    await expect(preparation.arm(request)).rejects.toThrow(
      /mission insert failed/i,
    );
    expect(discardRuntimeSquad).toHaveBeenCalledWith(runtimeSquad);
    expect(store.current()).toBeNull();
  });

  it('removes the exact unfenced mission when runtime fencing fails', async () => {
    const store = createStoreHarness();
    const discardRuntimeSquad = vi.fn(() => true);
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad: () => runtimeSquad,
        getSquad: () => runtimeSquad,
        resolveRuntime: () => {
          throw new Error('provider readiness changed');
        },
        discardRuntimeSquad,
      },
    });
    const armed = await preparation.arm(request);
    await preparation.compile(request, armed);

    await expect(
      preparation.persistReviewFence({
        missionId: armed.missionId,
        reviewSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/provider readiness changed/i);
    expect(store.missions.removeIfUnchanged).toHaveBeenCalledOnce();
    expect(discardRuntimeSquad).toHaveBeenCalledWith(runtimeSquad);
    expect(store.current()).toBeNull();
  });

  it('accepts a reread runtime squad regardless of the armed lane', async () => {
    const store = createStoreHarness();
    const consultRequest: MissionPrepareRequest = {
      ...request,
      advanced: { lane: 'consult' },
      roster: request.roster.map((agent) => ({
        ...agent,
        allowedTools: ['Read'],
      })),
    };
    let currentRuntimeSquad: Squad = {
      ...runtimeSquad,
      agents: consultRequest.roster.map((agent) => ({ ...agent })),
    };
    const discardRuntimeSquad = vi.fn(() => true);
    const preparation = createMissionEnginePreparationPorts({
      scope,
      missions: store.missions,
      deps: {
        now: () => 200,
        persistRuntimeSquad: () => currentRuntimeSquad,
        getSquad: (id) =>
          id === currentRuntimeSquad.id ? currentRuntimeSquad : null,
        resolveRuntime: () => runtime,
        discardRuntimeSquad,
      },
    });
    const armed = await preparation.arm(consultRequest);
    await preparation.compile(consultRequest, armed);
    currentRuntimeSquad = {
      ...currentRuntimeSquad,
      agents: currentRuntimeSquad.agents.map((agent) =>
        agent.category === 'executor'
          ? { ...agent, allowedTools: ['Read', 'Edit'] }
          : { ...agent },
      ),
    };

    await expect(
      preparation.persistReviewFence({
        missionId: armed.missionId,
        reviewSha256: 'a'.repeat(64),
      }),
    ).resolves.toBeUndefined();
    expect(store.missions.bindMissionRuntimeSquad).toHaveBeenCalled();
    expect(discardRuntimeSquad).not.toHaveBeenCalled();
    expect(store.current()).not.toBeNull();
  });

  it('removes an exact unfenced preparation and its runtime squad once', async () => {
    const { store, preparation, discardRuntimeSquad } =
      createCleanupHarness();
    const armed = await preparation.arm(request);
    const preparedMission = store.current();

    expect(
      await preparation.discardUnfencedPreparation({
        missionId: armed.missionId,
        createdAt: armed.createdAt,
      }),
    ).toBe(true);
    expect(store.missions.removeIfUnchanged).toHaveBeenCalledWith(
      armed.missionId,
      preparedMission,
    );
    expect(store.current()).toBeNull();
    expect(discardRuntimeSquad).toHaveBeenCalledOnce();
    expect(discardRuntimeSquad).toHaveBeenCalledWith(runtimeSquad);

    expect(
      await preparation.discardUnfencedPreparation({
        missionId: armed.missionId,
        createdAt: armed.createdAt,
      }),
    ).toBe(false);
    expect(store.missions.removeIfUnchanged).toHaveBeenCalledOnce();
    expect(discardRuntimeSquad).toHaveBeenCalledOnce();
  });

  it('refuses stale preparation authority without touching the mission or squad', async () => {
    const { store, preparation, discardRuntimeSquad } =
      createCleanupHarness();
    const armed = await preparation.arm(request);
    const preparedMission = store.current();

    expect(
      await preparation.discardUnfencedPreparation({
        missionId: armed.missionId,
        createdAt: armed.createdAt + 1,
      }),
    ).toBe(false);
    expect(store.current()).toBe(preparedMission);
    expect(store.missions.removeIfUnchanged).not.toHaveBeenCalled();
    expect(discardRuntimeSquad).not.toHaveBeenCalled();
  });

  it('keeps the runtime squad when exact mission removal loses its CAS', async () => {
    const { store, preparation, discardRuntimeSquad } =
      createCleanupHarness();
    const armed = await preparation.arm(request);
    const preparedMission = store.current();
    store.missions.removeIfUnchanged.mockReturnValueOnce('changed');

    expect(
      await preparation.discardUnfencedPreparation({
        missionId: armed.missionId,
        createdAt: armed.createdAt,
      }),
    ).toBe(false);
    expect(store.missions.removeIfUnchanged).toHaveBeenCalledWith(
      armed.missionId,
      preparedMission,
    );
    expect(store.current()).toBe(preparedMission);
    expect(discardRuntimeSquad).not.toHaveBeenCalled();
  });

  it('refuses fenced preparation authority without touching the mission or squad', async () => {
    const { store, preparation, discardRuntimeSquad } =
      createCleanupHarness();
    const armed = await preparation.arm(request);
    await preparation.compile(request, armed);
    await preparation.persistReviewFence({
      missionId: armed.missionId,
      reviewSha256: 'a'.repeat(64),
    });
    const fencedMission = store.current();

    expect(
      await preparation.discardUnfencedPreparation({
        missionId: armed.missionId,
        createdAt: armed.createdAt,
      }),
    ).toBe(false);
    expect(fencedMission?.intentContract?.approvalReviewSha256).toBe(
      'a'.repeat(64),
    );
    expect(store.current()).toBe(fencedMission);
    expect(store.missions.removeIfUnchanged).not.toHaveBeenCalled();
    expect(discardRuntimeSquad).not.toHaveBeenCalled();
  });

});

describe('rosterIdentityMatches — selo de equipe sem bytes de capacidade', () => {
  const base = {
    id: 'a1',
    agentName: 'Executor',
    category: 'executor' as const,
    cli: 'codex',
    model: 'gpt-5.6-terra',
  };

  it('ignora allowedSkills/allowedTools (autoridade main-owned)', () => {
    expect(
      rosterIdentityMatches(
        [{ ...base, allowedSkills: ['impeccable'], allowedTools: [] }],
        [{ ...base, allowedSkills: [], allowedTools: null }],
      ),
    ).toBe(true);
  });

  it('detecta troca de identidade — CLI, papel ou modelo', () => {
    expect(
      rosterIdentityMatches([{ ...base }], [{ ...base, cli: 'claude' }]),
    ).toBe(false);
    expect(
      rosterIdentityMatches(
        [{ ...base }],
        [{ ...base, category: 'reviewer' as const }],
      ),
    ).toBe(false);
    expect(rosterIdentityMatches([{ ...base }], [])).toBe(false);
  });
});
