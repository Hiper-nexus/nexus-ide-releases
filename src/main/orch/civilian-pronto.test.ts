import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Handoff, Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  applyCivilianProntoDecision,
  decideCivilianPronto,
  holdsGuidedOrLegacyReview,
  inspectProductEvidence,
  maybeApplyCivilianPronto,
  walkProductFiles,
} from './civilian-pronto';
import { hasUnsettledQueuedHandoffs } from './civilian-delivery-completion';
import { projectMissionSnapshot } from './mission-snapshot';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

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
  hasQueuedHandoffs: false,
  idleWorkersWithoutHandoff: 0,
  workersDelivered: false,
  orchestratorBusy: false,
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

  it('todos os workers entregaram handoff e Maestro parou → Pronto', () => {
    const decision = decideCivilianPronto({
      ...running,
      boardAllDone: false,
      sealedDone: 0,
      sealedTotal: 1,
      workersDelivered: true,
      orchestratorBusy: false,
    });
    expect(decision).toMatchObject({
      action: 'pronto',
      path: 'handoffs',
      reason: 'all-workers-delivered (0/1)',
    });
  });

  it('worker idle sem handoff bloqueia Pronto mesmo com board N/N', () => {
    expect(
      decideCivilianPronto({
        ...running,
        boardAllDone: true,
        sealedDone: 20,
        sealedTotal: 20,
        idleWorkersWithoutHandoff: 1,
      }).action,
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

describe('walkProductFiles — evidência sem lixo', () => {
  it('dotfiles e logs não são prova de entrega (.env é segredo, não artefato)', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-walk-'));
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, '.DS_Store'), 'junk');
    writeFileSync(join(root, 'debug.log'), 'log');
    writeFileSync(join(root, 'landing.html'), '<h1>oi</h1>');
    const files = walkProductFiles(root);
    expect(files).toEqual(['landing.html']);
  });
});

describe('settlement idempotente — success em voo não prende o Pronto', () => {
  it('handoff success ainda queued fecha via handoffs citando a resposta', () => {
    expect(
      hasUnsettledQueuedHandoffs([
        { deliveryState: 'queued', status: 'success' },
      ]),
    ).toBe(false);

    const scope = testProjectScope();
    const mission = {
      id: 'mission-1mais1',
      title: 'pergunte 1+1',
      description: 'consolide as respostas',
      status: 'running',
      intentState: 'executing',
      intentVersion: 0,
      updatedAt: 100,
      learnings: '',
    } as unknown as Mission;
    const queuedSuccess = {
      id: 'handoff-1mais1',
      missionId: mission.id,
      fromAgent: 'Frontend',
      status: 'success',
      claimTrust: 'untrusted',
      summary: '2',
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      delivered: false,
      deliveryState: 'queued',
      createdAt: 50,
    } as Handoff;
    const persistedMission = { ...mission };
    const completeVerified = vi.fn(
      (..._args: unknown[]) => {
        const persisted = persistedMission as {
          status: string;
          result: unknown;
        };
        persisted.status = 'done';
        persisted.result = { outcome: 'success', summary: '2' };
      },
    );
    const deps = {
      getStores: () =>
        ({
          missions: { get: () => persistedMission },
          tasks: {
            list: () => [
              {
                missionId: mission.id,
                id: 't-ask',
                title: 'Frontend',
                detail: '',
                status: 'pending',
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            listPlannedTasks: () => [],
          },
          handoffs: { list: () => [queuedSuccess] },
        }) as unknown as ProjectDomainStoreSuite,
      listPanes: () => [
        {
          missionId: mission.id,
          agentName: 'Frontend',
          role: 'worker',
          state: 'exited',
        },
      ],
      listProductFiles: () => [] as readonly string[],
      missionEngine: { completeVerified },
    };
    const completed = maybeApplyCivilianPronto(scope, mission.id, deps);
    expect(completed.action).toBe('pronto');
    expect(completed.path).toBe('handoffs');
    expect(completed.completed).toBe(true);
    expect(completeVerified).toHaveBeenCalledOnce();
    const call = completeVerified.mock.calls[0]?.[1] as
      | { result: { summary: string } }
      | undefined;
    expect(call?.result.summary).toContain('2');
  });
});
