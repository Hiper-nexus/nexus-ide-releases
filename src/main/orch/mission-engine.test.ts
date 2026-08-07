import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  MissionEngineCommand,
  MissionPrepareRequest,
} from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  MainMissionEngine,
  type MainMissionEnginePorts,
} from './mission-engine';
import { MissionEngineRegistry } from './mission-engine-registry';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import type { ProjectMissionSnapshotView } from './mission-snapshot';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-1',
  projectId: 'project-1',
  checkoutId: 'checkout-1',
  rootRealPath: '/workspace/nexus-ide',
  identitySource: 'manifest',
};

const request: MissionPrepareRequest = {
  objective: 'Build the main-owned mission engine.',
  contextPaths: ['src/main/orch'],
  roster: [
    {
      id: 'agent-1',
      agentName: 'Implementer',
      category: 'executor',
      cli: 'codex',
    },
  ],
};

function snapshotView(): ProjectMissionSnapshotView {
  return {
    mission: {
      id: 'mission-1',
      title: 'Mission engine',
      objective: request.objective,
      workspaceLabel: 'nexus-ide',
      status: 'running',
      version: 3,
      updatedAt: 1_777_000_000_100,
    },
    hasDispatchAuthority: true,
    hasCurrentKickoffReceipt: true,
    orchestratorLive: true,
    tasks: [],
    handoffs: [],
    panes: [],
    roster: request.roster,
  };
}

function createPorts(
  overrides: Partial<MainMissionEnginePorts> = {},
): MainMissionEnginePorts {
  return {
    arm: vi.fn(async () => ({
      missionId: 'mission-1',
      workspaceLabel: 'nexus-ide',
      createdAt: 1_777_000_000_000,
    })),
    compile: vi.fn(async () => ({
      title: 'Mission engine',
      objective: request.objective,
      contextPaths: request.contextPaths,
      roster: request.roster,
      permissions: [{ id: 'write-project', label: 'Write project files' }],
      warnings: [],
    })),
    persistReviewFence: vi.fn(async () => undefined),
    readReviewFence: vi.fn(async () => ({
      missionId: 'mission-1',
      reviewSha256: 'a'.repeat(64),
    })),
    seal: vi.fn(async () => undefined),
    bootstrap: vi.fn(async () => undefined),
    retryKickoff: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    direct: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    blockUser: vi.fn(() => snapshotView()),
    blockTechnical: vi.fn(() => snapshotView()),
    resumeTechnical: vi.fn(() => undefined),
    completeVerified: vi.fn(() => snapshotView()),
    readSnapshotView: vi.fn(async () => snapshotView()),
    listSnapshotViews: vi.fn(async () => [snapshotView()]),
    ...overrides,
  };
}

function storeSuite(boundScope: ProjectExecutionScope): ProjectDomainStoreSuite {
  return {
    scope: boundScope,
    missions: {} as ProjectDomainStoreSuite['missions'],
    missionPanes: {} as ProjectDomainStoreSuite['missionPanes'],
    handoffs: {} as ProjectDomainStoreSuite['handoffs'],
    tasks: {} as ProjectDomainStoreSuite['tasks'],
    taskDispatches: {} as ProjectDomainStoreSuite['taskDispatches'],
    todos: {} as ProjectDomainStoreSuite['todos'],
  };
}

describe('MainMissionEngine', () => {
  it('owns arm, compile, canonical review hashing, and fence persistence in order', async () => {
    const calls: string[] = [];
    const ports = createPorts({
      arm: vi.fn(async () => {
        calls.push('arm');
        return {
          missionId: 'mission-1',
          workspaceLabel: 'nexus-ide',
          createdAt: 1_777_000_000_000,
        };
      }),
      compile: vi.fn(async () => {
        calls.push('compile');
        return {
          warnings: [],
          roster: request.roster,
          permissions: [{ label: 'Write project files', id: 'write-project' }],
          contextPaths: request.contextPaths,
          objective: request.objective,
          title: 'Mission engine',
        };
      }),
      persistReviewFence: vi.fn(async () => {
        calls.push('persist-fence');
      }),
    });
    const engine = new MainMissionEngine(scope, ports);

    const review = await engine.prepare(scope, request);

    const canonicalReviewPayload = JSON.stringify({
      contextPaths: ['src/main/orch'],
      createdAt: 1_777_000_000_000,
      missionId: 'mission-1',
      objective: 'Build the main-owned mission engine.',
      permissions: [{ id: 'write-project', label: 'Write project files' }],
      roster: [
        {
          agentName: 'Implementer',
          category: 'executor',
          cli: 'codex',
          id: 'agent-1',
        },
      ],
      title: 'Mission engine',
      warnings: [],
      workspaceLabel: 'nexus-ide',
    });
    const expectedSha = createHash('sha256')
      .update(canonicalReviewPayload)
      .digest('hex');

    expect(calls).toEqual(['arm', 'compile', 'persist-fence']);
    expect(review.reviewSha256).toBe(expectedSha);
    expect(ports.persistReviewFence).toHaveBeenCalledWith({
      missionId: 'mission-1',
      reviewSha256: expectedSha,
    });
    expect(JSON.stringify(review)).not.toContain(scope.rootRealPath);
  });

  it.each(['/absolute/context', 'C:\\private\\context', '../outside'])(
    'rejects non-root-relative prepare context %s before arming',
    async (contextPath) => {
      const ports = createPorts();
      const engine = new MainMissionEngine(scope, ports);

      await expect(
        engine.prepare(scope, { ...request, contextPaths: [contextPath] }),
      ).rejects.toThrow();
      expect(ports.arm).not.toHaveBeenCalled();
    },
  );

  it('fails closed when compilation returns an unsafe context path', async () => {
    const ports = createPorts({
      compile: vi.fn(async () => ({
        title: 'Mission engine',
        objective: request.objective,
        contextPaths: ['/private/context'],
        roster: request.roster,
        permissions: [],
        warnings: [],
      })),
    });
    const engine = new MainMissionEngine(scope, ports);

    await expect(engine.prepare(scope, request)).rejects.toThrow();
    expect(ports.persistReviewFence).not.toHaveBeenCalled();
  });

  it('revalidates the review fence before sealing, bootstraps, then reads fresh state', async () => {
    const calls: string[] = [];
    const ports = createPorts({
      readReviewFence: vi.fn(async () => {
        calls.push('read-fence');
        return { missionId: 'mission-1', reviewSha256: 'a'.repeat(64) };
      }),
      seal: vi.fn(async () => {
        calls.push('seal');
      }),
      bootstrap: vi.fn(async () => {
        calls.push('bootstrap');
      }),
      readSnapshotView: vi.fn(async () => {
        calls.push('read-snapshot');
        return snapshotView();
      }),
    });
    const engine = new MainMissionEngine(scope, ports);

    const snapshot = await engine.start(scope, {
      missionId: 'mission-1',
      reviewSha256: 'a'.repeat(64),
    });

    expect(calls).toEqual([
      'read-fence',
      'seal',
      'bootstrap',
      'read-snapshot',
    ]);
    expect(ports.seal).toHaveBeenCalledWith({
      missionId: 'mission-1',
      reviewSha256: 'a'.repeat(64),
    });
    expect(snapshot.id).toBe('mission-1');
  });

  it.each([
    [null, 'a'],
    [{ missionId: 'mission-1', reviewSha256: 'b'.repeat(64) }, 'a'],
    [{ missionId: 'other', reviewSha256: 'a'.repeat(64) }, 'a'],
  ] as const)('rejects an absent or mismatched review fence', async (fence, inputSha) => {
    const ports = createPorts({ readReviewFence: vi.fn(async () => fence) });
    const engine = new MainMissionEngine(scope, ports);

    await expect(
      engine.start(scope, {
        missionId: 'mission-1',
        reviewSha256: inputSha.repeat(64),
      }),
    ).rejects.toThrow(/review fence/i);
    expect(ports.seal).not.toHaveBeenCalled();
    expect(ports.bootstrap).not.toHaveBeenCalled();
  });

  it('strictly routes every command kind through its explicit handler before a fresh read', async () => {
    const calls: string[] = [];
    const ports = createPorts({
      retryKickoff: vi.fn(async () => {
        calls.push('retry-kickoff');
      }),
      resume: vi.fn(async () => {
        calls.push('resume');
      }),
      stop: vi.fn(async () => {
        calls.push('stop');
      }),
      direct: vi.fn(async () => {
        calls.push('direct');
      }),
      answerQuestion: vi.fn(async () => {
        calls.push('answer-question');
      }),
      readSnapshotView: vi.fn(async () => {
        calls.push('snapshot');
        return snapshotView();
      }),
    });
    const engine = new MainMissionEngine(scope, ports);
    const commands: MissionEngineCommand[] = [
      { kind: 'retry-kickoff', missionId: 'mission-1' },
      { kind: 'resume', missionId: 'mission-1' },
      { kind: 'stop', missionId: 'mission-1' },
      {
        kind: 'direct',
        missionId: 'mission-1',
        targetAgentId: null,
        text: 'Continue with the focused implementation.',
      },
      {
        kind: 'answer-question',
        missionId: 'mission-1',
        questionId: 'question-1',
        optionId: 'stable',
      },
    ];

    for (const command of commands) {
      await engine.command(scope, command);
    }

    expect(calls).toEqual([
      'retry-kickoff',
      'snapshot',
      'resume',
      'snapshot',
      'stop',
      'snapshot',
      'direct',
      'snapshot',
      'answer-question',
      'snapshot',
    ]);
  });

  it('routes main-only lifecycle writes synchronously through one scoped port', () => {
    const calls: string[] = [];
    const ports = {
      ...createPorts(),
      blockUser: vi.fn(() => {
        calls.push('block-user');
      }),
      blockTechnical: vi.fn(() => {
        calls.push('block-technical');
      }),
      resumeTechnical: vi.fn(() => {
        calls.push('resume-technical');
      }),
      completeVerified: vi.fn(() => {
        calls.push('complete-verified');
      }),
    };
    const engine = new MainMissionEngine(scope, ports);
    const fence = {
      missionId: 'mission-1',
      expectedStatus: 'running' as const,
      expectedIntentState: 'executing' as const,
      expectedUpdatedAt: 1_777_000_000_100,
      expectedIntentVersion: 3,
    };

    engine.blockUser(scope, {
      ...fence,
      description: 'Aguardando uma decisão humana.',
    });
    engine.blockTechnical(scope, {
      ...fence,
      description: 'Falha técnica retryable.',
    });
    engine.resumeTechnical(scope, {
      ...fence,
      expectedStatus: 'blocked',
      expectedIntentState: 'blocked_technical',
      description: 'Retry técnico autorizado.',
    });
    engine.completeVerified(scope, {
      ...fence,
      learnings: 'Plano, PREVC e evidências verificados.',
    });

    expect(calls).toEqual([
      'block-user',
      'block-technical',
      'resume-technical',
      'complete-verified',
    ]);
    expect(ports.blockUser).toHaveBeenCalledOnce();
    expect(ports.blockTechnical).toHaveBeenCalledOnce();
    expect(ports.resumeTechnical).toHaveBeenCalledOnce();
    expect(ports.completeVerified).toHaveBeenCalledOnce();
  });

  it('rejects malformed commands without invoking a handler', async () => {
    const ports = createPorts();
    const engine = new MainMissionEngine(scope, ports);

    await expect(
      engine.command(scope, {
        kind: 'resume',
        missionId: 'mission-1',
        token: 'must-not-cross',
      } as never),
    ).rejects.toThrow();
    await expect(
      engine.command(scope, {
        kind: 'answer-question',
        missionId: 'mission-1',
        questionId: 'question-1',
      } as never),
    ).rejects.toThrow();
    expect(ports.resume).not.toHaveBeenCalled();
    expect(ports.answerQuestion).not.toHaveBeenCalled();
  });

  it('rejects construction when any required port is absent', () => {
    const names = [
      'arm',
      'compile',
      'persistReviewFence',
      'readReviewFence',
      'seal',
      'bootstrap',
      'retryKickoff',
      'resume',
      'stop',
      'direct',
      'answerQuestion',
      'blockUser',
      'blockTechnical',
      'resumeTechnical',
      'completeVerified',
      'readSnapshotView',
      'listSnapshotViews',
    ] as const satisfies readonly (keyof MainMissionEnginePorts)[];

    for (const name of names) {
      const candidate = { ...createPorts() } as Record<string, unknown>;
      delete candidate[name];
      expect(
        () =>
          new MainMissionEngine(
            scope,
            candidate as unknown as MainMissionEnginePorts,
          ),
        name,
      ).toThrow(name);
    }
  });

  it('asserts the exact immutable bound scope on every method', async () => {
    const ports = createPorts();
    const engine = new MainMissionEngine(scope, ports);
    const wrongScope = { ...scope, rootRealPath: '/workspace/other' };
    const lifecycleFence = {
      missionId: 'mission-1',
      expectedStatus: 'running' as const,
      expectedIntentState: 'executing' as const,
      expectedUpdatedAt: 1_777_000_000_100,
      expectedIntentVersion: 3,
    };

    await expect(engine.prepare(wrongScope, request)).rejects.toThrow(/scope/i);
    await expect(
      engine.start(wrongScope, {
        missionId: 'mission-1',
        reviewSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/scope/i);
    await expect(
      engine.command(wrongScope, {
        kind: 'resume',
        missionId: 'mission-1',
      }),
    ).rejects.toThrow(/scope/i);
    expect(() =>
      engine.blockUser(wrongScope, {
        ...lifecycleFence,
        description: 'Aguardando operador.',
      }),
    ).toThrow(/scope/i);
    expect(() =>
      engine.blockTechnical(wrongScope, {
        ...lifecycleFence,
        description: 'Falha técnica.',
      }),
    ).toThrow(/scope/i);
    expect(() =>
      engine.resumeTechnical(wrongScope, {
        ...lifecycleFence,
        description: 'Retomar após falha técnica.',
      }),
    ).toThrow(/scope/i);
    expect(() =>
      engine.completeVerified(wrongScope, {
        ...lifecycleFence,
        learnings: 'Conclusão verificada.',
      }),
    ).toThrow(/scope/i);
    await expect(engine.snapshot(wrongScope, 'mission-1')).rejects.toThrow(
      /scope/i,
    );
    await expect(engine.list(wrongScope)).rejects.toThrow(/scope/i);
    expect(ports.arm).not.toHaveBeenCalled();
    expect(ports.readReviewFence).not.toHaveBeenCalled();
    expect(ports.resume).not.toHaveBeenCalled();
    expect(ports.blockUser).not.toHaveBeenCalled();
    expect(ports.blockTechnical).not.toHaveBeenCalled();
    expect(ports.resumeTechnical).not.toHaveBeenCalled();
    expect(ports.completeVerified).not.toHaveBeenCalled();
    expect(ports.readSnapshotView).not.toHaveBeenCalled();
    expect(ports.listSnapshotViews).not.toHaveBeenCalled();
  });

  it('strictly parses every list view before producing summaries', async () => {
    const validPorts = createPorts();
    const validEngine = new MainMissionEngine(scope, validPorts);

    await expect(validEngine.list(scope)).resolves.toEqual([
      {
        id: 'mission-1',
        title: 'Mission engine',
        state: 'running',
        progress: { completed: 0, total: 0 },
        needsAttention: false,
        updatedAt: 1_777_000_000_100,
      },
    ]);

    const malformed = { ...snapshotView(), reviewReceipt: 'must-not-cross' };
    const invalidEngine = new MainMissionEngine(
      scope,
      createPorts({ listSnapshotViews: vi.fn(async () => [malformed] as never) }),
    );
    await expect(invalidEngine.list(scope)).rejects.toThrow();
  });
});

describe('MissionEngineRegistry', () => {
  it('caches exactly one engine per full immutable scope and passes through its store suite', () => {
    const stores = storeSuite(scope);
    const engine = new MainMissionEngine(scope, createPorts());
    const factory = vi.fn(() => engine);
    const registry = new MissionEngineRegistry(factory);

    const first = registry.forScope(scope, stores);
    const second = registry.forScope({ ...scope }, stores);

    expect(first).toBe(engine);
    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(scope, stores);
  });

  it('throws on a canonical-key identity collision instead of reusing authority', () => {
    const registry = new MissionEngineRegistry(
      (boundScope) => new MainMissionEngine(boundScope, createPorts()),
    );
    registry.forScope(scope, storeSuite(scope));
    const collidingScope = {
      ...scope,
      identitySource: 'provisional' as const,
    };

    expect(() =>
      registry.forScope(collidingScope, storeSuite(collidingScope)),
    ).toThrow(/identity collision/i);
  });

  it('rejects a store suite bound to a different scope', () => {
    const registry = new MissionEngineRegistry(
      (boundScope) => new MainMissionEngine(boundScope, createPorts()),
    );
    const wrongScope = { ...scope, rootRealPath: '/workspace/other' };

    expect(() => registry.forScope(scope, storeSuite(wrongScope))).toThrow(
      /scope/i,
    );
  });
});
