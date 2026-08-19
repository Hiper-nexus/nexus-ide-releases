import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  applyCivilianProntoDecision,
  decideCivilianPronto,
  holdsGuidedOrLegacyReview,
  inspectProductEvidence,
} from './civilian-pronto';
import { projectMissionSnapshot } from './mission-snapshot';

const running = {
  missionStatus: 'running',
  failClosed: false,
  boardAllDone: false,
  sealedDone: 5,
  sealedTotal: 5,
  hasSuccessHandoff: true,
  productFileCount: 12,
  designOnly: false,
  neverStarted: false,
  liveWriterBusy: false,
  holdForGuidedReview: false,
} as const;

describe('decideCivilianPronto', () => {
  it('board N/N justifica Pronto sem pintar números', () => {
    const decision = decideCivilianPronto({
      ...running,
      boardAllDone: true,
      sealedDone: 20,
      sealedTotal: 20,
      hasSuccessHandoff: false,
      productFileCount: 0,
    });
    expect(decision).toMatchObject({
      action: 'pronto',
      path: 'board',
      sealedDone: 20,
      sealedTotal: 20,
    });
  });

  it('16/20 selado pendente espera — header Pronto só em 20/20', () => {
    const leftover = decideCivilianPronto({
      ...running,
      sealedDone: 16,
      sealedTotal: 20,
      hasSuccessHandoff: true,
      productFileCount: 7,
      liveWriterBusy: false,
    });
    expect(leftover.action).toBe('wait');
    expect(leftover.reason).toBe('sealed-pending');
    expect(leftover.path).toBeNull();

    const done = decideCivilianPronto({
      ...running,
      boardAllDone: true,
      sealedDone: 20,
      sealedTotal: 20,
      hasSuccessHandoff: true,
      productFileCount: 7,
    });
    expect(done).toMatchObject({
      action: 'pronto',
      path: 'board',
      sealedDone: 20,
      sealedTotal: 20,
    });
  });

  it('files-modified/handoff sem plano selado ainda justifica Pronto', () => {
    const decision = decideCivilianPronto({
      ...running,
      sealedDone: 0,
      sealedTotal: 0,
      hasSuccessHandoff: true,
      productFileCount: 67,
      liveWriterBusy: false,
    });
    expect(decision.action).toBe('pronto');
    expect(decision.path).toBe('files-modified/handoff');
  });

  it('writer ainda busy espera — não fecha cedo', () => {
    expect(
      decideCivilianPronto({ ...running, liveWriterBusy: true }).action,
    ).toBe('wait');
  });

  it('guided/legacy com revisor pendente não pula Maestro/revisor', () => {
    expect(
      holdsGuidedOrLegacyReview({
        orchestrationMode: 'guided',
        pendingReviewer: true,
      }),
    ).toBe(true);
    expect(
      decideCivilianPronto({
        ...running,
        holdForGuidedReview: true,
      }).action,
    ).toBe('wait');
    expect(
      holdsGuidedOrLegacyReview({
        orchestrationMode: 'livre',
        pendingReviewer: true,
      }),
    ).toBe(false);
  });

  it('zero arquivos / DESIGN-only / rascunho recusam', () => {
    expect(
      decideCivilianPronto({
        ...running,
        hasSuccessHandoff: false,
        productFileCount: 0,
        neverStarted: true,
      }).action,
    ).toBe('refuse');
    expect(
      decideCivilianPronto({
        ...running,
        hasSuccessHandoff: false,
        productFileCount: 0,
        designOnly: true,
      }).action,
    ).toBe('refuse');
    expect(inspectProductEvidence(['DESIGN.md']).designOnly).toBe(true);
    expect(
      decideCivilianPronto({
        ...running,
        hasSuccessHandoff: false,
        productFileCount: 3,
        sealedDone: 0,
        neverStarted: false,
      }).action,
    ).toBe('wait');
  });
});

describe('Pronto justified → mission status pronto', () => {
  it('grava done+result; snapshot completed mesmo com leftover writers', () => {
    const scope = testProjectScope();
    const mission = {
      id: 'mission-1cebd658',
      title: 'SaaS 20',
      description: 'exatamente 20 user stories',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      updatedAt: 100,
      learnings: '',
    } as unknown as Mission;
    const persisted = { ...mission, status: 'done' as const, result: null as unknown };
    const completeVerified = vi.fn(() => {
      persisted.status = 'done';
      persisted.result = {
        outcome: 'success',
        summary: 'Pronto justified by files-modified/handoff (5/5).',
        evidenceIds: [],
        artifactRefs: ['server.js'],
      };
    });

    const completed = applyCivilianProntoDecision({
      scope,
      mission,
      decision: {
        action: 'pronto',
        path: 'files-modified/handoff',
        reason: 'files-modified/handoff (5/5)',
        sealedDone: 5,
        sealedTotal: 5,
      },
      productFiles: ['server.js', 'stories/01.md'],
      engine: { completeVerified },
      stores: {
        missions: {
          get: () => persisted as unknown as Mission,
        },
      } as unknown as Parameters<typeof applyCivilianProntoDecision>[0]['stores'],
    });

    expect(completed).toBe(true);
    expect(completeVerified).toHaveBeenCalledOnce();
    expect(persisted.status).toBe('done');

    const snapshot = projectMissionSnapshot({
      mission: {
        id: mission.id,
        title: mission.title,
        objective: 'exatamente 20 user stories',
        workspaceLabel: 'saas-20stories-060',
        status: 'done',
        result: {
          outcome: 'success',
          summary: 'Pronto justified by files-modified/handoff (5/5).',
          evidenceIds: [],
          artifactRefs: ['server.js'],
        },
        version: 2,
        updatedAt: 200,
      },
      hasDispatchAuthority: false,
      hasCurrentKickoffReceipt: true,
      orchestratorLive: true,
      tasks: [
        { id: 't1', title: 'Frontend', status: 'done', dependsOn: [], evidence: [] },
        { id: 't2', title: 'Backend', status: 'done', dependsOn: [], evidence: [] },
        { id: 't3', title: 'Generalist', status: 'done', dependsOn: [], evidence: [] },
        { id: 't4', title: 'UX Designer', status: 'done', dependsOn: [], evidence: [] },
        { id: 't5', title: 'QA', status: 'done', dependsOn: [], evidence: [] },
      ],
      handoffs: [],
      panes: [
        { paneId: 'g', agentId: 'generalist', state: 'working' },
        { paneId: 'ux', agentId: 'ux', state: 'working' },
      ],
      roster: [
        { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
        { id: 'generalist', agentName: 'Generalist', category: 'executor', cli: 'codex' },
        { id: 'ux', agentName: 'UX Designer', category: 'reviewer', cli: 'codex' },
      ],
    });
    expect(snapshot.state).toBe('completed');
    expect(snapshot.progress).toEqual({ completed: 5, total: 5 });
  });
});
