import { describe, expect, it } from 'vitest';
import {
  missionAllowedActionSchema,
  missionEngineCommandSchema,
  missionLifecycleStateSchema,
  missionPrepareRequestSchema,
  missionReviewSchema,
  missionSnapshotSchema,
  missionSummarySnapshotSchema,
} from './mission-engine-contract';

const agent = {
  id: 'coordinator',
  agentName: 'Coordinator',
  category: 'orchestrator' as const,
  cli: 'codex',
};
const executorAgent = {
  ...agent,
  id: 'executor',
  agentName: 'Executor',
  category: 'executor' as const,
};
const reviewerAgent = {
  ...agent,
  id: 'reviewer',
  agentName: 'Reviewer',
  category: 'reviewer' as const,
};
const standardRoster = [agent, executorAgent, reviewerAgent];


const progress = { completed: 1, total: 2 };

const snapshot = {
  id: 'mission-1',
  title: 'Revisar projeto',
  objective: 'Revisar o projeto e relatar os riscos',
  workspaceLabel: 'nexus-ide',
  state: 'running' as const,
  stateReason: {
    code: 'execution-active',
    label: 'Execução em andamento',
  },
  progress,
  agents: [
    {
      ...agent,
      state: 'working' as const,
      currentUnitId: 'unit-2',
      paneId: 'pane-1',
      detail: 'Revisando o contrato',
    },
  ],
  edges: [
    {
      id: 'edge-1',
      sourceAgentId: 'coordinator',
      targetAgentId: 'reviewer',
      kind: 'review' as const,
      label: 'Revisão final',
    },
  ],
  units: [
    {
      id: 'unit-1',
      title: 'Mapear riscos',
      status: 'done' as const,
      agentId: 'coordinator',
      dependsOn: [],
      evidenceIds: ['evidence-1'],
    },
  ],
  question: {
    id: 'question-1',
    prompt: 'Qual caminho devo seguir?',
    targetAgentId: 'coordinator',
    options: [
      {
        id: 'safe',
        label: 'Caminho seguro',
        description: 'Preserva o estado atual',
      },
    ],
    allowFreeText: true,
  },
  result: {
    outcome: 'partial' as const,
    summary: 'Revisão ainda em andamento',
    evidenceIds: ['evidence-1'],
    artifactRefs: ['artifact-1'],
  },
  allowedActions: ['direct', 'stop'] as const,
  version: 3,
  updatedAt: 1_786_000_000_000,
};

describe('canonical mission lifecycle', () => {
  it('accepts the complete canonical lifecycle and no parallel state', () => {
    for (const state of [
      'draft',
      'review_ready',
      'starting',
      'running',
      'blocked_user',
      'blocked_technical',
      'recovering',
      'stopping',
      'failed',
      'completed',
    ] as const) {
      expect(missionLifecycleStateSchema.parse(state)).toBe(state);
    }

    expect(missionLifecycleStateSchema.safeParse('approved').success).toBe(false);
  });

  it('accepts only main-projected allowed actions', () => {
    for (const action of [
      'start',
      'retry-kickoff',
      'answer-question',
      'direct',
      'stop',
      'resume',
    ] as const) {
      expect(missionAllowedActionSchema.parse(action)).toBe(action);
    }
  });
});

describe('mission preparation and review', () => {
  it('accepts the renderer-owned preparation fields', () => {
    expect(
      missionPrepareRequestSchema.parse({
        objective: 'Revisar o projeto',
        title: 'Revisão',
        contextPaths: ['src/shared'],
        acceptanceCriteria: ['Nenhum risco crítico permanece sem evidência.'],
        roster: [agent],
        advanced: { lane: 'consult' },
      }),
    ).toEqual({
      objective: 'Revisar o projeto',
      title: 'Revisão',
      acceptanceCriteria: ['Nenhum risco crítico permanece sem evidência.'],
      contextPaths: ['src/shared'],
      roster: [agent],
      advanced: { lane: 'consult' },
    });
  });

  it('aceita o opt-in de escolha livre em advanced', () => {
    const parsed = missionPrepareRequestSchema.parse({
      objective: 'Implementar e verificar a entrega',
      contextPaths: [],
      roster: standardRoster,
      advanced: { lane: 'standard', freeAgentChoice: true },
    });
    expect(parsed.advanced).toEqual({
      lane: 'standard',
      freeAgentChoice: true,
    });
  });

  it('rejects a standard delivery roster without an executor or reviewer', () => {
    const base = {
      objective: 'Implementar e verificar a entrega',
      contextPaths: [],
      advanced: { lane: 'standard' as const },
    };

    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        roster: [agent, reviewerAgent],
      }).success,
    ).toBe(false);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        roster: [agent, executorAgent],
      }).success,
    ).toBe(false);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        roster: standardRoster,
      }).success,
    ).toBe(true);
  });


  it('keeps preparation text within durable mission-store limits', () => {
    const base = {
      contextPaths: [],
      roster: standardRoster,
    };
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        objective: 'x'.repeat(16_384),
      }).success,
    ).toBe(true);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        objective: 'x'.repeat(16_385),
      }).success,
    ).toBe(false);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        objective: 'x',
        title: 't'.repeat(512),
      }).success,
    ).toBe(true);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        objective: 'x',
        title: 't'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...base,
        objective: 'x',
        contextPaths: ['../fora-do-projeto.ts'],
      }).success,
    ).toBe(false);
  });

  it('bounds operator-authored acceptance criteria in prepare and review', () => {
    const request = {
      objective: 'Revisar o projeto',
      contextPaths: [],
      roster: standardRoster,
    };
    expect(
      missionPrepareRequestSchema.safeParse({
        ...request,
        acceptanceCriteria: ['Critério verificável'],
      }).success,
    ).toBe(true);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...request,
        acceptanceCriteria: Array.from({ length: 33 }, (_, index) => `C${index}`),
      }).success,
    ).toBe(false);
    expect(
      missionPrepareRequestSchema.safeParse({
        ...request,
        acceptanceCriteria: ['x'.repeat(2_049)],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['authoritySeal', 'renderer-controlled'],
    ['approvalSecret', 'renderer-controlled'],
    ['bearerToken', 'renderer-controlled'],
    ['sealedPrompt', 'renderer-controlled'],
    ['rawWorkspaceAuthority', '/private/workspace'],
  ])('rejects renderer authority field %s', (field, value) => {
    expect(() =>
      missionPrepareRequestSchema.parse({
        objective: 'Revisar o projeto',
        contextPaths: [],
        roster: standardRoster,
        [field]: value,
      }),
    ).toThrow();
  });

  it('accepts a bounded renderer-safe review', () => {
    expect(
      missionReviewSchema.parse({
        missionId: 'mission-1',
        title: 'Revisão',
        objective: 'Revisar o projeto',
        workspaceLabel: 'nexus-ide',
        contextPaths: ['src/shared'],
        roster: [agent],
        acceptanceCriteria: ['Nenhum risco crítico permanece sem evidência.'],
        permissions: [
          {
            id: 'workspace-read',
            label: 'Ler o workspace',
            detail: 'Leitura dos arquivos selecionados',
          },
        ],
        warnings: ['A missão pode alterar arquivos.'],
        reviewSha256: 'a'.repeat(64),
        createdAt: 1_786_000_000_000,
      }),
    ).toMatchObject({ missionId: 'mission-1', reviewSha256: 'a'.repeat(64) });
  });
});

describe('mission engine commands', () => {
  it.each([
    { kind: 'retry-kickoff', missionId: 'm1' },
    { kind: 'resume', missionId: 'm1' },
    { kind: 'stop', missionId: 'm1' },
    {
      kind: 'direct',
      missionId: 'm1',
      targetAgentId: null,
      text: 'Revise o plano',
    },
    {
      kind: 'answer-question',
      missionId: 'm1',
      questionId: 'q1',
      optionId: 'o1',
    },
    {
      kind: 'answer-question',
      missionId: 'm1',
      questionId: 'q1',
      text: 'Siga pelo caminho seguro',
    },
  ])('accepts $kind', (command) => {
    expect(missionEngineCommandSchema.parse(command)).toEqual(command);
  });

  it('requires an answer payload', () => {
    expect(() =>
      missionEngineCommandSchema.parse({
        kind: 'answer-question',
        missionId: 'm1',
        questionId: 'q1',
      }),
    ).toThrow();
  });

  it('rejects blank answers, unknown fields, and start authority', () => {
    expect(
      missionEngineCommandSchema.safeParse({
        kind: 'answer-question',
        missionId: 'm1',
        questionId: 'q1',
        text: '   ',
      }).success,
    ).toBe(false);
    expect(
      missionEngineCommandSchema.safeParse({
        kind: 'stop',
        missionId: 'm1',
        authoritySeal: 'renderer-controlled',
      }).success,
    ).toBe(false);
    expect(
      missionEngineCommandSchema.safeParse({ kind: 'start', missionId: 'm1' })
        .success,
    ).toBe(false);
  });
});

describe('renderer-safe mission snapshots', () => {
  it('requires and preserves every presentation field', () => {
    expect(missionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('enforces verifiable progress', () => {
    expect(
      missionSnapshotSchema.safeParse({
        ...snapshot,
        progress: { completed: 3, total: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects sensitive authority fields at public boundaries', () => {
    for (const field of [
      'authoritySeal',
      'approvalSecret',
      'bearerToken',
      'sealedPrompt',
      'rawWorkspaceAuthority',
    ]) {
      expect(
        missionSnapshotSchema.safeParse({ ...snapshot, [field]: 'sensitive' })
          .success,
      ).toBe(false);
    }

    expect(
      missionSnapshotSchema.safeParse({
        ...snapshot,
        agents: [{ ...snapshot.agents[0], sealedPrompt: 'sensitive' }],
      }).success,
    ).toBe(false);
  });

  it('rejects snapshot roster values rejected by canonical validation', () => {
    const agentWithBidiControl = {
      ...agent,
      agentName: 'Coordinator\u202e',
    };

    expect(
      missionPrepareRequestSchema.safeParse({
        objective: 'Revisar o projeto',
        contextPaths: [],
        roster: [agentWithBidiControl],
      }).success,
    ).toBe(false);
    expect(
      missionSnapshotSchema.safeParse({
        ...snapshot,
        agents: [{ ...agentWithBidiControl, state: 'working' }],
      }).success,
    ).toBe(false);
  });

  it('accepts the strict mission list summary', () => {
    expect(
      missionSummarySnapshotSchema.parse({
        id: snapshot.id,
        title: snapshot.title,
        state: snapshot.state,
        stateReason: snapshot.stateReason,
        progress,
        needsAttention: false,
        updatedAt: snapshot.updatedAt,
      }),
    ).toEqual({
      id: snapshot.id,
      title: snapshot.title,
      state: snapshot.state,
      stateReason: snapshot.stateReason,
      progress,
      needsAttention: false,
      updatedAt: snapshot.updatedAt,
    });
  });
});
