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
        roster: [agent],
        advanced: { lane: 'consult' },
      }),
    ).toEqual({
      objective: 'Revisar o projeto',
      title: 'Revisão',
      contextPaths: ['src/shared'],
      roster: [agent],
      advanced: { lane: 'consult' },
    });
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
        roster: [agent],
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
