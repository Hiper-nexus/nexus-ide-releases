import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  requestPaneSpawn: async () => ({ ok: false }),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => {
    throw new Error('getProjectDomainStores deve ser injetado no teste');
  },
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    completeVerified: () => {
      throw new Error('missionEngine deve ser injetado no teste');
    },
  }),
}));

vi.mock('./squad-store', () => ({
  getSquad: () => null,
}));

const autoReviewSpy = vi.hoisted(() => ({
  enforceCivilianAutoReview: vi.fn(async () => ({
    kind: 'approved' as const,
    evidenceId: 'nexus-auto-review:test-hash',
    note: 'Scanner determinístico candidate-quality-v1: aprovado (teste).',
  })),
}));

vi.mock('./civilian-auto-review', () => ({
  resolveAutoReviewBaseSha: async () => null,
  enforceCivilianAutoReview: autoReviewSpy.enforceCivilianAutoReview,
}));

vi.mock('../context/candidate-working-tree-snapshot', () => ({
  captureWorkingTreeCandidate: async () => ({ fingerprint: 'candidate-1', complete: true }),
}));

import type { Handoff, Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  CIVILIAN_REVIEW_QUEUE_GRACE_MS,
  decideCivilianDeliveryAction,
  hasUnsettledQueuedHandoffs,
  inspectCivilianDelivery,
  inspectDeliveryEvidence,
  listDeliveredProductFiles,
  maybeCompleteFastLaneOnDelivery,
  toArtifactRefs,
} from './civilian-delivery-completion';
import { maybeApplyCivilianPronto } from './civilian-pronto';
import { getAutomaticCompletionProof } from './automatic-completion-proof';
import type { ScopedTaskRecord } from './task-store';
import { MissionLeadershipError } from './mission-leadership';

const scope = testProjectScope({ rootRealPath: '/workspace/waitlist' });

function decision(
  overrides: Partial<Parameters<typeof decideCivilianDeliveryAction>[0]> = {},
): Parameters<typeof decideCivilianDeliveryAction>[0] {
  return {
    failClosed: false,
    boardAllDone: false,
    hasExpectedDelivery: false,
    designOnly: false,
    neverStartedDraft: false,
    hasSuccessHandoff: true,
    hasRealWorkerDelivery: true,
    holdForReview: false,
    productFileCount: 3,
    activeWriterCount: 0,
    workersDelivered: true,
    remainingKinds: [],
    oldestReviewQueuedMs: null,
    hasQueuedHandoffs: false,
    idleWorkersWithoutHandoff: 0,
    orchestratorBusy: false,
    ...overrides,
  };
}

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-a906d36d',
    title: 'Waitlist',
    description: 'eu quero isso → software pronto: server.js e public/index.html',
    status: 'running',
    squadId: 'nexus-fullstack',
    intentState: 'executing',
    intentVersion: 1,
    updatedAt: 1_000,
    createdAt: 1,
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

function task(
  overrides: Partial<ScopedTaskRecord> & Pick<ScopedTaskRecord, 'id' | 'title'>,
): ScopedTaskRecord {
  return {
    missionId: 'mission-a906d36d',
    detail: '',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    ...overrides,
  };
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'handoff-front',
    missionId: 'mission-a906d36d',
    fromAgent: 'Frontend',
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'Formulário de email no ar.',
    artifacts: [{ path: 'public/index.html' }, 'server.js'],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'consumed',
    createdAt: 50,
    ...overrides,
  };
}

function storyPlan(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `t-story-${index + 1}`,
    agentCategory: 'executor' as const,
    agent: {
      id: `writer-${index + 1}`,
      agentName: `Story ${index + 1}`,
      category: 'executor' as const,
    },
  }));
}

describe('decideCivilianDeliveryAction', () => {
  it('board all-done → Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          boardAllDone: true,
          hasSuccessHandoff: false,
          hasExpectedDelivery: false,
          productFileCount: 0,
          workersDelivered: false,
        }),
      ),
    ).toBe('complete');
  });

  it('Pedir um ajuste segura o closer de board N/N até handoff novo', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          boardAllDone: true,
          awaitingOperatorAdjustment: true,
        }),
      ),
    ).toBe('wait');
  });

  it('board all-done + orchestrator busy → wait (Maestro pode spawnar mais workers)', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          boardAllDone: true,
          orchestratorBusy: true,
          hasSuccessHandoff: false,
          hasExpectedDelivery: false,
          productFileCount: 0,
          workersDelivered: false,
        }),
      ),
    ).toBe('wait');
  });

  it('board all-done + orchestrator idle → Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          boardAllDone: true,
          orchestratorBusy: false,
          hasSuccessHandoff: true,
          hasExpectedDelivery: true,
          productFileCount: 3,
          workersDelivered: true,
        }),
      ),
    ).toBe('complete');
  });

  it('evidence path + orchestrator busy → wait', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasExpectedDelivery: true,
          hasRealWorkerDelivery: true,
          activeWriterCount: 0,
          orchestratorBusy: true,
        }),
      ),
    ).toBe('wait');
  });

  it('arquivos no disco + never-started selado → reroute (não Pronto 16/20)', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasSuccessHandoff: false,
          hasExpectedDelivery: true,
          hasRealWorkerDelivery: true,
          workersDelivered: false,
          remainingKinds: ['sat', 'never-started'],
        }),
      ),
    ).toBe('reroute');
  });

  it('entrega + resto sat/never-started (story ainda pending) → reroute, não Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasExpectedDelivery: true,
          hasRealWorkerDelivery: true,
          remainingKinds: ['sat'],
        }),
      ),
    ).toBe('reroute');
  });

  it('DESIGN.md sozinho → nunca Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          designOnly: true,
          hasExpectedDelivery: false,
          productFileCount: 1,
        }),
      ),
    ).toBe('refuse-empty');
  });

  it('rascunho nunca iniciado → nunca Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          neverStartedDraft: true,
          hasExpectedDelivery: false,
          hasRealWorkerDelivery: false,
          remainingKinds: ['never-started'],
        }),
      ),
    ).toBe('refuse-empty');
  });

  it('rascunho nunca iniciado + leftover no cwd → nunca Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          neverStartedDraft: true,
          hasExpectedDelivery: true,
          hasRealWorkerDelivery: false,
          productFileCount: 3,
          remainingKinds: ['never-started'],
        }),
      ),
    ).toBe('refuse-empty');
  });

  it('fail-closed (sandbox / authority / spawn) → nunca Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          failClosed: true,
          boardAllDone: true,
          hasExpectedDelivery: true,
        }),
      ),
    ).toBe('refuse-fail-closed');
  });

  it('legacy/regression com review pendente → espera (não pula Maestro/revisor)', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasExpectedDelivery: true,
          holdForReview: true,
          remainingKinds: ['review'],
          oldestReviewQueuedMs: 8_000,
        }),
      ),
    ).toBe('wait');
  });

  it('entrega + workers feitos + resto vazio → Pronto', () => {
    expect(decideCivilianDeliveryAction(decision())).toBe('complete');
  });

  it('entrega + resto só review recém-enfileirado → Pronto (civil não espera cerimônia)', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          remainingKinds: ['review', 'review'],
          oldestReviewQueuedMs: 8_000,
        }),
      ),
    ).toBe('complete');
  });

  it('entrega + review na fila tempo demais → spawn (ou complete no apply)', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          remainingKinds: ['review', 'never-started'],
          oldestReviewQueuedMs: CIVILIAN_REVIEW_QUEUE_GRACE_MS,
        }),
      ),
    ).toBe('spawn-review');
  });

  it('zero arquivos → nunca Pronto', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasExpectedDelivery: false,
          productFileCount: 0,
        }),
      ),
    ).toBe('refuse-empty');
  });

  it('sem handoff success e sem evidência, ou writer ainda busy → espera', () => {
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasSuccessHandoff: false,
          hasExpectedDelivery: false,
          hasRealWorkerDelivery: false,
          workersDelivered: false,
          productFileCount: 2,
        }),
      ),
    ).toBe('wait');
    expect(
      decideCivilianDeliveryAction(
        decision({
          hasExpectedDelivery: true,
          activeWriterCount: 1,
          remainingKinds: ['blocking'],
        }),
      ),
    ).toBe('wait');
  });
});

describe('inspectDeliveryEvidence', () => {
  it('server + page + package conta como entrega esperada', () => {
    const evidence = inspectDeliveryEvidence([
      'package.json',
      'server.js',
      'public/index.html',
    ]);
    expect(evidence.expected).toBe(true);
    expect(evidence.designOnly).toBe(false);
  });

  it('DESIGN.md sozinho não é entrega', () => {
    const evidence = inspectDeliveryEvidence(['DESIGN.md']);
    expect(evidence.expected).toBe(false);
    expect(evidence.designOnly).toBe(true);
    expect(evidence.productFiles).toEqual([]);
  });

  it('arquivo pedido no kickoff conta como entrega', () => {
    const evidence = inspectDeliveryEvidence(
      ['resumo.txt'],
      'Leia brief.txt e escreva a primeira frase em resumo.txt.',
    );
    expect(evidence.expected).toBe(true);
  });

  it('landing.html na raiz + server.js + smoke é entrega (stress-waitlist)', () => {
    const evidence = inspectDeliveryEvidence([
      'server.js',
      'landing.html',
      'smoke-stories.js',
    ]);
    expect(evidence.expected).toBe(true);
    expect(evidence.designOnly).toBe(false);
  });
});

describe('hasUnsettledQueuedHandoffs — paste no Maestro ainda não aconteceu', () => {
  it('success queued é unsettled — Pronto não pode pular o idle-delivery', () => {
    expect(
      hasUnsettledQueuedHandoffs([
        handoff({ deliveryState: 'queued', status: 'success' }),
      ]),
    ).toBe(true);
    expect(
      hasUnsettledQueuedHandoffs([
        handoff({ deliveryState: 'submitted', status: 'success' }),
      ]),
    ).toBe(false);
    expect(hasUnsettledQueuedHandoffs([])).toBe(false);
  });

  it('queued do próprio Maestro não prende o Pronto', () => {
    expect(
      hasUnsettledQueuedHandoffs(
        [
          handoff({
            deliveryState: 'queued',
            status: 'success',
            sessionId: 'maestro-pty',
            fromAgent: 'Coordenar e revisar',
          }),
        ],
        { orchestratorSessionId: 'maestro-pty' },
      ),
    ).toBe(false);
  });

  it('handoff success ainda queued bloqueia decisão até o paste', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission(),
      tasks: [task({ id: 't-front', title: 'UI', status: 'pending' })],
      planned: [
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
      ],
      handoffs: [handoff({ deliveryState: 'queued', status: 'success' })],
      panes: [],
      now: 20_000,
    });
    expect(inspected.hasQueuedHandoffs).toBe(true);
    expect(inspected.workersDelivered).toBe(true);
  });

  it('queued do orquestrador provado (A e C concordam) não prende a decisão', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission(),
      tasks: [task({ id: 't-front', title: 'UI', status: 'pending' })],
      planned: [
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
      ],
      handoffs: [handoff({ deliveryState: 'queued', status: 'success', sessionId: 'maestro-1' })],
      panes: [],
      now: 20_000,
      provenOrchestratorSessionId: 'maestro-1',
    });
    expect(inspected.hasQueuedHandoffs).toBe(false);
  });

  it('sem líder provado (A morto ou ausente), o queued do "orquestrador" continua contando', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission(),
      tasks: [task({ id: 't-front', title: 'UI', status: 'pending' })],
      planned: [
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
      ],
      handoffs: [handoff({ deliveryState: 'queued', status: 'success', sessionId: 'maestro-1' })],
      panes: [],
      now: 20_000,
      provenOrchestratorSessionId: undefined,
    });
    expect(inspected.hasQueuedHandoffs).toBe(true);
  });
});

describe('toArtifactRefs — resultado sem lixo do workspace', () => {
  it('filtra dotfiles (.env é SEGREDO), logs e mantém entrega real', () => {
    expect(
      toArtifactRefs([
        'landing.html',
        '.DS_Store',
        '.env',
        'out-dev.log',
        'src/app.ts',
        'docs/.gitignore',
      ]),
    ).toEqual(['landing.html', 'src/app.ts']);
  });
});

describe('inspectCivilianDelivery', () => {
  it('marca writer com handoff success como entregue e review como resto', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission(),
      tasks: [
        task({ id: 't-back', title: 'API', status: 'done' }),
        task({ id: 't-front', title: 'UI', status: 'pending' }),
        task({ id: 't-ux', title: 'UX', status: 'pending', createdAt: 10 }),
      ],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
        {
          taskId: 't-ux',
          agentCategory: 'reviewer',
          agent: { id: 'ux', agentName: 'UX Designer', category: 'reviewer' },
        },
      ],
      handoffs: [handoff()],
      panes: [],
      now: 20_000,
    });
    expect(inspected.hasSuccessHandoff).toBe(true);
    expect(inspected.workersDelivered).toBe(true);
    expect(inspected.deliveredWorkerTaskIds).toEqual(['t-front']);
    expect(inspected.remaining.map((row) => row.kind)).toEqual(['review']);
  });

  it('writer idle/parou não é live e não bloqueia o board 0/20', () => {
    const planned = storyPlan(20);
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-20stories-c' }),
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-20stories-c',
        }),
      ),
      planned,
      handoffs: [],
      panes: Array.from({ length: 7 }, (_, index) => ({
        missionId: 'mission-20stories-c',
        agentName: `Story ${index + 1}`,
        role: 'worker' as const,
        state: index < 5 ? 'idle' : 'exited',
      })),
      now: 60_000,
    });
    expect(inspected.boardAllDone).toBe(false);
    expect(inspected.activeWriterCount).toBe(0);
    expect(inspected.hasRealWorkerDelivery).toBe(true);
    expect(inspected.neverStartedDraft).toBe(false);
    expect(inspected.remaining.filter((row) => row.kind === 'sat')).toHaveLength(7);
    expect(
      inspected.remaining.filter((row) => row.kind === 'never-started'),
    ).toHaveLength(13);
    expect(inspected.remaining.some((row) => row.kind === 'blocking')).toBe(false);
  });

  it('pane Frontend/Backend idle conta mesmo se o board chama Story 01 (0/12)', () => {
    const planned = storyPlan(12);
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-stress-12' }),
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-12',
        }),
      ),
      planned,
      handoffs: [],
      panes: [
        {
          missionId: 'mission-stress-12',
          agentName: 'Frontend',
          role: 'worker',
          state: 'idle',
        },
        {
          missionId: 'mission-stress-12',
          agentName: 'Backend',
          role: 'worker',
          state: 'parou',
        },
        {
          missionId: 'mission-stress-12',
          agentName: 'Maestro',
          role: 'orchestrator',
          state: 'idle',
        },
      ],
      now: 60_000,
    });
    expect(inspected.boardAllDone).toBe(false);
    expect(inspected.activeWriterCount).toBe(0);
    expect(inspected.hasRealWorkerDelivery).toBe(true);
    expect(inspected.neverStartedDraft).toBe(false);
  });

  it('pane Frontend ainda busy bloqueia mesmo com nomes diferentes do board', () => {
    const planned = storyPlan(3);
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-stress-waitlist' }),
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-waitlist',
        }),
      ),
      planned,
      handoffs: [],
      panes: [
        {
          missionId: 'mission-stress-waitlist',
          agentName: 'Frontend',
          role: 'worker',
          state: 'busy',
        },
        {
          missionId: 'mission-stress-waitlist',
          agentName: 'Backend',
          role: 'worker',
          state: 'idle',
        },
      ],
      now: 20_000,
    });
    expect(inspected.activeWriterCount).toBe(1);
    expect(inspected.hasRealWorkerDelivery).toBe(true);
    expect(inspected.neverStartedDraft).toBe(false);
  });

  it('plano órfão (planned vazio) + writers idle no pane ainda é entrega real', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-orphan-plan' }),
      tasks: [
        task({ id: 't-story-1', title: 'Story 01', missionId: 'mission-orphan-plan' }),
        task({ id: 't-story-2', title: 'Story 02', missionId: 'mission-orphan-plan' }),
      ],
      planned: [],
      handoffs: [],
      panes: [
        {
          missionId: 'mission-orphan-plan',
          agentName: 'Frontend',
          role: 'worker',
          state: 'idle',
        },
      ],
      now: 20_000,
    });
    expect(inspected.hasRealWorkerDelivery).toBe(true);
    expect(inspected.neverStartedDraft).toBe(false);
    expect(inspected.activeWriterCount).toBe(0);
  });

  it('board 1/3 (uma task done) é entrega real mesmo sem pane e sem handoff', () => {
    const planned = storyPlan(3);
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-stress-waitlist' }),
      tasks: planned.map((row, index) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-waitlist',
          status: index === 0 ? 'done' : 'pending',
        }),
      ),
      planned,
      handoffs: [],
      panes: [],
      now: 20_000,
    });
    expect(inspected.hasRealWorkerDelivery).toBe(true);
    expect(inspected.neverStartedDraft).toBe(false);
    expect(inspected.boardAllDone).toBe(false);
    expect(inspected.activeWriterCount).toBe(0);
  });

  it('orchestratorBusy true quando Maestro está busy', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-orch-busy' }),
      tasks: [
        task({ id: 't-story-1', title: 'Story 01', missionId: 'mission-orch-busy', status: 'done' }),
      ],
      planned: storyPlan(1),
      handoffs: [handoff({ missionId: 'mission-orch-busy' })],
      panes: [
        {
          missionId: 'mission-orch-busy',
          agentName: 'Maestro',
          role: 'orchestrator',
          state: 'busy',
        },
      ],
      now: 20_000,
    });
    expect(inspected.orchestratorBusy).toBe(true);
    expect(inspected.boardAllDone).toBe(true);
  });

  it('orchestratorBusy false quando Maestro está idle ou ausente', () => {
    const inspected = inspectCivilianDelivery({
      mission: mission({ id: 'mission-orch-idle' }),
      tasks: [
        task({ id: 't-story-1', title: 'Story 01', missionId: 'mission-orch-idle', status: 'done' }),
      ],
      planned: storyPlan(1),
      handoffs: [handoff({ missionId: 'mission-orch-idle' })],
      panes: [
        {
          missionId: 'mission-orch-idle',
          agentName: 'Maestro',
          role: 'orchestrator',
          state: 'idle',
        },
      ],
      now: 20_000,
    });
    expect(inspected.orchestratorBusy).toBe(false);
    expect(inspected.boardAllDone).toBe(true);
  });
});

describe('listDeliveredProductFiles', () => {
  it.each([false, true])('descobre saída pós-início sem declaração de arquivos (commit=%s)', async (commit) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'civilian-discovery-')));
    const createdAt = Date.now() - 2_000;
    try {
      if (commit) execFileSync('git', ['init', '--quiet'], { cwd: root });
      writeFileSync(join(root, 'index.html'), '<h1>Minha loja</h1>');
      if (commit) {
        execFileSync('git', ['add', 'index.html'], { cwd: root });
        execFileSync('git', ['-c', 'user.name=Nexus test', '-c', 'user.email=test@nexus.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Create page'], { cwd: root });
      }
      expect(await listDeliveredProductFiles(root, [handoff({ artifacts: [], summary: 'Página criada' })], 'Faça uma página', createdAt))
        .toContain('index.html');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('só conta arquivo real e não-vazio; artifact mentiroso não basta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'civilian-files-'));
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'server.js'), 'console.log("ok")\n');
    writeFileSync(join(root, 'public/index.html'), '<form></form>\n');
    writeFileSync(join(root, 'empty.txt'), '');
    const files = await listDeliveredProductFiles(root, [
      handoff({
        artifacts: [
          { path: 'server.js' },
          { path: 'public/index.html' },
          { path: 'empty.txt' },
          { path: 'missing.json' },
        ],
      }),
    ]);
    expect(files).toEqual(
      expect.arrayContaining(['public/index.html', 'server.js']),
    );
    expect(files).not.toContain('empty.txt');
    expect(files).not.toContain('missing.json');
  });
});

describe('maybeCompleteFastLaneOnDelivery', () => {
  const completeVerified = vi.fn();
  const blockUser = vi.fn();

  function harness(input: {
    files: string[];
    tasks: ScopedTaskRecord[];
    planned: Parameters<typeof inspectCivilianDelivery>[0]['planned'];
    handoffs?: Handoff[];
    panes?: Parameters<typeof inspectCivilianDelivery>[0]['panes'];
    now?: number;
    spawn?: string[];
    missionStatus?: Mission['status'];
    intentState?: Mission['intentState'];
    description?: string;
    missionId?: string;
    missionOverrides?: Partial<Mission>;
    depsExtras?: Record<string, unknown>;
  }) {
    const marked: string[] = [];
    const liveMission = mission({
      id: input.missionId ?? 'mission-a906d36d',
      status: input.missionStatus ?? 'running',
      intentState: input.intentState ?? 'executing',
      description: input.description ?? mission().description,
      ...input.missionOverrides,
    });
    const stores = {
      missions: {
        get: (id: string) => {
          if (id !== liveMission.id) return null;
          return liveMission;
        },
      },
      handoffs: {
        list: () => input.handoffs ?? [handoff()],
      },
      tasks: {
        list: () => input.tasks,
        listPlannedTasks: () =>
          input.planned.map((row) => ({
            ...row,
            plannerId: row.taskId,
            missionId: liveMission.id,
            intentVersion: 1,
            squadId: 'nexus-fullstack',
            rosterHash: 'a'.repeat(64),
            agentRef: row.agent.id,
            plannedTitle: row.agent.agentName,
            plannedDetail: '',
            task: input.tasks.find((item) => item.id === row.taskId)!,
          })),
        markLifecycleStatus: (taskId: string, status: 'running' | 'done' | 'failed') => {
          marked.push(taskId);
          const current = input.tasks.find((item) => item.id === taskId);
          if (!current) return null;
          current.status = status;
          return current;
        },
        advanceSealedTaskStatus: (taskId: string, status: 'running' | 'done' | 'failed') => {
          marked.push(taskId);
          const current = input.tasks.find((item) => item.id === taskId);
          if (!current) return null;
          current.status = status;
          return current;
        },
      },
    };
    completeVerified.mockImplementation(() => {
      liveMission.status = 'done';
      (liveMission as Mission & { result?: unknown }).result = {
        outcome: 'success',
        summary: 'ok',
        evidenceIds: [],
        artifactRefs: input.files,
      };
    });
    return {
      marked,
      liveMission,
      stores,
      reconcile: (executionScope = scope) =>
        maybeCompleteFastLaneOnDelivery(executionScope, liveMission.id, {
          getStores: () => stores,
          listPanes: () => input.panes ?? [],
          listProductFiles: () => input.files,
          now: () => input.now ?? 10_000,
          spawnReviewers: async () => input.spawn ?? [],
          missionEngine: { completeVerified, blockUser },
          getSquad: () => ({
            agents: input.planned.map((row) => ({
              id: row.agent.id,
              agentName: row.agent.agentName,
              category: row.agent.category,
              cli: 'codex',
            })),
          }),
          // Onda 1 (religação da liderança): default sem líder provado, o
          // mesmo efeito que `mission.orchestratorSessionId` ausente tinha
          // pré-religação. Testes que precisam de um líder injetam via
          // `depsExtras.resolveMissionLeader`.
          resolveMissionLeader: () => null,
          ...(input.depsExtras ?? {}),
        }),
    };
  }

  it('religação onda 1: split-brain nunca é engolido — recusa fail-closed com o código, sem escolher líder por ordem de array', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      missionId: 'mission-split-brain',
      files: ['server.js'],
      tasks: [],
      planned: [],
      handoffs: [],
      depsExtras: {
        resolveMissionLeader: () => {
          throw new MissionLeadershipError('split_brain', {
            missionId: 'mission-split-brain',
            sessionIds: ['session-a', 'session-b'],
          });
        },
      },
    });
    const result = await reconcile();
    expect(result.action).toBe('refuse-fail-closed');
    expect(result.reason).toBe('leadership-split_brain');
    expect(result.completed).toBe(false);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('files-on-disk + 20 never-started → reroute, não Pronto 0/20', async () => {
    completeVerified.mockClear();
    const planned = storyPlan(20);
    const { reconcile } = harness({
      missionId: 'mission-20stories-c',
      files: [
        'package.json',
        'server.js',
        'public/index.html',
        ...Array.from({ length: 14 }, (_, index) => `src/story-${index + 1}.ts`),
      ],
      handoffs: [],
      panes: Array.from({ length: 7 }, (_, index) => ({
        missionId: 'mission-20stories-c',
        agentName: `Story ${index + 1}`,
        role: 'worker' as const,
        state: 'idle',
      })),
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-20stories-c',
        }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(result.action).toBe('reroute');
    expect(result.completed).toBe(false);
    expect(result.path).toBeNull();
    expect(completeVerified).not.toHaveBeenCalled();
    expect(planned.every((_, index) => {
      void index;
      return true;
    })).toBe(true);
  });

  it('067 leftover 16/20: Landing + story-01-landing.html vai done; resto pending não tosta Pronto', async () => {
    completeVerified.mockClear();
    const titles = [
      'Landing',
      ...Array.from({ length: 15 }, (_, index) => `Story ${index + 2} da waitlist`),
      'Admin lista emails',
      'Contador da fila',
      'Extra leftover',
      'Favicon e OG',
    ];
    const planned = titles.map((title, index) => ({
      taskId: `t-story-${index + 1}`,
      agentCategory: 'executor' as const,
      agent: {
        id: `writer-${index + 1}`,
        agentName: title,
        category: 'executor' as const,
      },
    }));
    const { marked, reconcile } = harness({
      missionId: 'mission-067',
      files: [
        'story-01-landing.html',
        'subscribe.js',
        '03-server-4367.js',
        '04-thank-you.html',
        '05-admin-lista-emails.js',
        'rate-limit.js',
        'unsubscribe.js',
      ],
      handoffs: [handoff({ missionId: 'mission-067' })],
      panes: [
        {
          missionId: 'mission-067',
          agentName: 'Writer 1',
          role: 'worker',
          state: 'idle',
        },
        {
          missionId: 'mission-067',
          agentName: 'Writer 2',
          role: 'worker',
          state: 'idle',
        },
      ],
      tasks: planned.map((row, index) =>
        task({
          id: row.taskId,
          title: titles[index]!,
          missionId: 'mission-067',
          status:
            titles[index] === 'Landing' ||
            titles[index] === 'Admin lista emails' ||
            titles[index] === 'Contador da fila' ||
            titles[index] === 'Favicon e OG'
              ? 'pending'
              : 'done',
        }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(marked).toEqual(
      expect.arrayContaining(['t-story-1', 't-story-17']),
    );
    expect(result.completed).toBe(false);
    expect(result.action).toBe('reroute');
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('DESIGN-only → not Pronto', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      files: ['DESIGN.md'],
      handoffs: [handoff({ artifacts: [{ path: 'DESIGN.md' }] })],
      panes: [
        {
          missionId: 'mission-a906d36d',
          agentName: 'Backend',
          role: 'worker',
          state: 'idle',
        },
      ],
      tasks: [task({ id: 't-back', title: 'Backend', status: 'pending' })],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(result.action).toBe('refuse-empty');
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('board all-done → Pronto', async () => {
    completeVerified.mockClear();
    const planned = storyPlan(3);
    const { marked, reconcile } = harness({
      files: ['server.js'],
      handoffs: [],
      tasks: planned.map((row) =>
        task({ id: row.taskId, title: row.agent.agentName, status: 'done' }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(result.action).toBe('complete');
    expect(result.completed).toBe(true);
    expect(result.path).toBe('board');
    expect(marked).toEqual([]);
    expect(completeVerified).toHaveBeenCalledOnce();
  });

  it('entrega + todos os workers feitos → Pronto e só avança quem entregou de verdade', async () => {
    completeVerified.mockClear();
    const { marked, reconcile } = harness({
      files: ['server.js', 'public/index.html', 'data/waitlist.json'],
      now: 12_000,
      tasks: [
        task({ id: 't-back', title: 'Backend', status: 'done' }),
        task({ id: 't-front', title: 'Frontend', status: 'pending' }),
        task({ id: 't-ux', title: 'UX', status: 'pending' }),
      ],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
        {
          taskId: 't-ux',
          agentCategory: 'reviewer',
          agent: { id: 'ux', agentName: 'UX Designer', category: 'reviewer' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.action).toBe('complete');
    expect(result.completed).toBe(true);
    expect(marked).toEqual(['t-front']);
    expect(completeVerified).toHaveBeenCalledOnce();
  });

  it('entrega + review na fila tempo demais → spawn quando o assento materializa', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      files: ['server.js'],
      now: CIVILIAN_REVIEW_QUEUE_GRACE_MS + 5_000,
      spawn: ['Revisor'],
      intentState: 'legacy',
      tasks: [
        task({ id: 't-back', title: 'Backend', status: 'done' }),
        task({
          id: 'guided-regression',
          title: 'Revisor',
          status: 'pending',
          createdAt: 1,
        }),
      ],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
        {
          taskId: 'guided-regression',
          agentCategory: 'reviewer',
          agent: { id: 'revisor', agentName: 'Revisor', category: 'reviewer' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.action).toBe('spawn-review');
    expect(result.completed).toBe(false);
    expect(result.spawnedReviewers).toEqual(['Revisor']);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('entrega + review na fila tempo demais sem spawn → Pronto civil', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      files: ['server.js'],
      now: CIVILIAN_REVIEW_QUEUE_GRACE_MS + 5_000,
      spawn: [],
      tasks: [
        task({ id: 't-back', title: 'Backend', status: 'done' }),
        task({ id: 't-ux', title: 'UX', status: 'pending', createdAt: 1 }),
      ],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
        {
          taskId: 't-ux',
          agentCategory: 'reviewer',
          agent: { id: 'ux', agentName: 'UX Designer', category: 'reviewer' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.completed).toBe(true);
    expect(result.action).toBe('complete');
    expect(completeVerified).toHaveBeenCalledOnce();
  });

  it('zero arquivos → nunca Pronto, mesmo com handoff success', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      files: [],
      tasks: [
        task({ id: 't-back', title: 'Backend', status: 'pending' }),
        task({ id: 't-front', title: 'Frontend', status: 'pending' }),
      ],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
        {
          taskId: 't-front',
          agentCategory: 'executor',
          agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.action).toBe('refuse-empty');
    expect(result.completed).toBe(false);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('blocked_technical / failed → nunca Pronto', async () => {
    completeVerified.mockClear();
    const blocked = harness({
      files: ['server.js', 'package.json'],
      intentState: 'blocked_technical',
      tasks: [task({ id: 't-back', title: 'Backend', status: 'done' })],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
      ],
    });
    const blockedResult = await blocked.reconcile();
    expect(blockedResult.action).toBe('refuse-fail-closed');
    expect(blockedResult.completed).toBe(false);

    const failed = harness({
      files: ['server.js'],
      missionStatus: 'failed',
      tasks: [task({ id: 't-back', title: 'Backend', status: 'done' })],
      planned: [
        {
          taskId: 't-back',
          agentCategory: 'executor',
          agent: { id: 'backend', agentName: 'Backend', category: 'executor' },
        },
      ],
    });
    expect((await failed.reconcile()).completed).toBe(false);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('stress-12: 17 arquivos + smoke + panes idle + board 0/12 → reroute, não Pronto', async () => {
    completeVerified.mockClear();
    const planned = storyPlan(12);
    const { reconcile } = harness({
      missionId: 'mission-stress-12',
      files: [
        'package.json',
        'server.js',
        'landing.html',
        'smoke-stories.js',
        ...Array.from({ length: 13 }, (_, index) => `src/story-${index + 1}.js`),
      ],
      handoffs: [],
      panes: [
        {
          missionId: 'mission-stress-12',
          agentName: 'Frontend',
          role: 'worker',
          state: 'idle',
        },
        {
          missionId: 'mission-stress-12',
          agentName: 'Backend',
          role: 'worker',
          state: 'parou',
        },
      ],
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-12',
        }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(result.action).toBe('reroute');
    expect(result.completed).toBe(false);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('stress-waitlist: 12 arquivos + smoke ok + board 1/3 + writers idle → espera/reroute, não Pronto', async () => {
    completeVerified.mockClear();
    const planned = storyPlan(3);
    const { reconcile } = harness({
      missionId: 'mission-stress-waitlist',
      files: [
        'server.js',
        'landing.html',
        'smoke-stories.js',
        'package.json',
        ...Array.from({ length: 8 }, (_, index) => `public/asset-${index + 1}.js`),
      ],
      handoffs: [],
      panes: [
        {
          missionId: 'mission-stress-waitlist',
          agentName: 'Frontend',
          role: 'worker',
          state: 'idle',
        },
        {
          missionId: 'mission-stress-waitlist',
          agentName: 'Backend',
          role: 'worker',
          state: 'idle',
        },
      ],
      tasks: planned.map((row, index) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-waitlist',
          status: index === 0 ? 'done' : 'pending',
        }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(['reroute', 'wait']).toContain(result.action);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('arquivos no disco + writer ainda busy (nome diferente do board) → espera, não finge Pronto', async () => {
    completeVerified.mockClear();
    const planned = storyPlan(3);
    const { reconcile } = harness({
      missionId: 'mission-stress-waitlist',
      files: ['server.js', 'landing.html', 'smoke-stories.js', 'package.json'],
      handoffs: [],
      panes: [
        {
          missionId: 'mission-stress-waitlist',
          agentName: 'Frontend',
          role: 'worker',
          state: 'busy',
        },
      ],
      tasks: planned.map((row) =>
        task({
          id: row.taskId,
          title: row.agent.agentName,
          missionId: 'mission-stress-waitlist',
        }),
      ),
      planned,
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(result.action).toBe('wait');
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('rascunho nunca iniciado + leftover package/server no cwd → não Pronto', async () => {
    completeVerified.mockClear();
    const { reconcile } = harness({
      files: ['package.json', 'server.js', 'public/index.html'],
      handoffs: [],
      panes: [],
      tasks: [task({ id: 't-story-1', title: 'Story 01', status: 'pending' })],
      planned: [
        {
          taskId: 't-story-1',
          agentCategory: 'executor',
          agent: { id: 'writer-1', agentName: 'Story 01', category: 'executor' },
        },
      ],
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(result.action).toBe('refuse-empty');
    expect(completeVerified).not.toHaveBeenCalled();
  });

  describe('revisão automática civil (Etapa 1)', () => {
  const civilianContract = {
    version: 1 as const,
    source: 'typed' as const,
    goal: 'criar uma landing simples',
    acceptanceCriteria: [] as string[],
    risk: 'normal' as const,
    executionMode: 'autopilot' as const,
    orchestrationMode: 'livre' as const,
  } as unknown as Mission['intentContract'];

  function boardDoneHarness(
    extras: {
      missionOverrides?: Record<string, unknown>;
      depsExtras?: Record<string, unknown>;
      panes?: Parameters<typeof inspectCivilianDelivery>[0]['panes'];
    } = {},
  ) {
    const planned = storyPlan(2);
    return harness({
      missionId: 'mission-civil-review',
      files: ['server.js'],
      handoffs: [],
      tasks: planned.map((row) =>
        task({ id: row.taskId, title: row.agent.agentName, status: 'done' }),
      ),
      planned,
      panes: extras.panes ?? [],
      missionOverrides: extras.missionOverrides as Partial<Mission>,
      depsExtras: extras.depsExtras,
    });
  }

  it('civil aprovada pelo scanner → completa com nota e evidência main-owned', async () => {
    completeVerified.mockClear();
    blockUser.mockClear();
    const runAutoReviewGate = vi.fn(async () => ({
      kind: 'approved' as const,
      evidenceId: 'nexus-auto-review:abc123',
      note: 'Scanner determinístico candidate-quality-v1: aprovado.',
    }));
    const { reconcile } = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });

    const result = await reconcile();
    expect(runAutoReviewGate).toHaveBeenCalledOnce();
    expect(result.completed).toBe(true);
    expect(blockUser).not.toHaveBeenCalled();
    const call = completeVerified.mock.calls[0]![1];
    expect(call.learnings).toContain('Revisão automática (main-owned)');
    expect(call.result.evidenceIds).toContain('nexus-auto-review:abc123');
  });

  it('religação onda 1: enforceCivilianAutoReview recebe o sessionId PROVADO, não um pane-scan ad-hoc', async () => {
    completeVerified.mockClear();
    autoReviewSpy.enforceCivilianAutoReview.mockClear();
    const { reconcile } = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: {
        resolveMissionLeader: () => ({
          sessionId: 'maestro-provado', paneId: 'pane-1', source: 'durable' as const, proven: true,
        }),
      },
    });
    await reconcile();
    expect(autoReviewSpy.enforceCivilianAutoReview).toHaveBeenCalledWith(
      expect.objectContaining({ liveOrchestratorSessionId: 'maestro-provado' }),
    );
  });

  it('religação onda 1: sem líder provado, enforceCivilianAutoReview recebe null (nunca escolhe um pane por heurística própria)', async () => {
    completeVerified.mockClear();
    autoReviewSpy.enforceCivilianAutoReview.mockClear();
    const { reconcile } = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: {
        resolveMissionLeader: () => ({
          sessionId: 'maestro-morto', paneId: 'pane-1', source: 'live' as const, proven: false,
        }),
      },
    });
    await reconcile();
    expect(autoReviewSpy.enforceCivilianAutoReview).toHaveBeenCalledWith(
      expect.objectContaining({ liveOrchestratorSessionId: null }),
    );
  });

  it('civil reprovada sem saída de reparo → bloqueia VISÍVEL com resumo simples', async () => {
    completeVerified.mockClear();
    blockUser.mockClear();
    const description =
      'A revisão automática encontrou 1 problema grave no código entregue.';
    const runAutoReviewGate = vi.fn(async () => ({
      kind: 'blocked' as const,
      description,
    }));
    const { reconcile } = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(result.action).toBe('refuse-fail-closed');
    expect(completeVerified).not.toHaveBeenCalled();
    expect(blockUser).toHaveBeenCalledOnce();
    expect(blockUser.mock.calls[0]![1]!.description).toBe(description);
  });

  it('civil com reparo despachado ao Maestro → espera, não completa', async () => {
    completeVerified.mockClear();
    blockUser.mockClear();
    const runAutoReviewGate = vi.fn(async () => ({
      kind: 'repair-dispatched' as const,
    }));
    const { reconcile } = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });

    const result = await reconcile();
    expect(result.completed).toBe(false);
    expect(result.action).toBe('wait');
    expect(completeVerified).not.toHaveBeenCalled();
    expect(blockUser).not.toHaveBeenCalled();
  });

  it('Pronto respeita reparo pendente mesmo com board completo e pane idle', async () => {
    completeVerified.mockClear();
    const runAutoReviewGate = vi.fn(async () => ({ kind: 'repair-dispatched' as const }));
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });

    const outcome = await maybeApplyCivilianPronto(scope, state.liveMission.id, {
      getStores: () => state.stores as never,
      listPanes: () => [],
      listProductFiles: () => ['server.js'],
      missionEngine: { completeVerified, blockUser },
      runAutoReviewGate,
      resolveMissionLeader: () => null,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.action).toBe('wait');
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('uma revisão em voo não duplica sensores nem empresta aprovação ao segundo caller', async () => {
    completeVerified.mockClear();
    let release!: () => void;
    const reviewing = new Promise<void>((resolve) => { release = resolve; });
    const runAutoReviewGate = vi.fn(async () => {
      await reviewing;
      return { kind: 'approved' as const, evidenceId: 'physical-review', note: 'verificado' };
    });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });
    const first = state.reconcile();
    await vi.waitFor(() => expect(runAutoReviewGate).toHaveBeenCalledOnce());
    const second = state.reconcile();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(runAutoReviewGate).toHaveBeenCalledOnce();
    expect(firstResult.completed).toBe(true);
    expect(secondResult).toMatchObject({ action: 'wait', completed: false, reason: 'review-in-progress' });
    expect(completeVerified).toHaveBeenCalledOnce();
  });

  it('mudança no candidato durante revisão impede concluir e a próxima tentativa revalida', async () => {
    completeVerified.mockClear();
    let fingerprint = 'before';
    const runAutoReviewGate = vi.fn(async () => {
      fingerprint = 'after';
      return { kind: 'approved' as const, evidenceId: 'physical-review', note: 'verificado' };
    });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: {
        runAutoReviewGate,
        captureCandidate: async () => ({ fingerprint, complete: true }),
      },
    });

    expect(await state.reconcile()).toMatchObject({ action: 'wait', completed: false, reason: 'review-candidate-changed' });
    expect(completeVerified).not.toHaveBeenCalled();
    expect((await state.reconcile()).completed).toBe(true);
    expect(runAutoReviewGate).toHaveBeenCalledTimes(2);
  });

  it('revisão negativa, reparo e aprovação concluem sem intervenção nova', async () => {
    completeVerified.mockClear();
    const runAutoReviewGate = vi.fn()
      .mockResolvedValueOnce({ kind: 'repair-dispatched' })
      .mockResolvedValueOnce({ kind: 'approved', evidenceId: 'repair-checked', note: 'reparo verificado' });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });

    expect((await state.reconcile()).action).toBe('wait');
    expect((await state.reconcile()).completed).toBe(true);
    expect(completeVerified).toHaveBeenCalledOnce();
  });

  it('workspace real sem Git detecta edição durante revisão e conclui na tentativa estável', async () => {
    completeVerified.mockClear();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-nongit-review-')));
    const localScope = testProjectScope({ rootRealPath: root });
    const snapshots = await vi.importActual<typeof import('../context/candidate-working-tree-snapshot')>('../context/candidate-working-tree-snapshot');
    writeFileSync(join(root, 'server.js'), 'export const value = 1;');
    const runAutoReviewGate = vi.fn(async () => {
      writeFileSync(join(root, 'server.js'), 'export const value = 2;');
      return { kind: 'approved' as const, evidenceId: 'physical-review', note: 'verificado' };
    });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate, captureCandidate: () => snapshots.captureWorkingTreeCandidate({ scope: localScope }) },
    });
    try {
      expect(await state.reconcile(localScope)).toMatchObject({ completed: false, reason: 'review-candidate-changed' });
      expect((await state.reconcile(localScope)).completed).toBe(true);
      expect(completeVerified).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('snapshot indisponível mantém entrega com nota honesta, sem espera permanente', async () => {
    completeVerified.mockClear();
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { captureCandidate: async () => { throw new Error('snapshot unavailable'); } },
    });

    expect((await state.reconcile()).completed).toBe(true);
    expect(completeVerified.mock.calls[0]![1].learnings)
      .toContain('checagem de mudanças durante a revisão foi parcial ou indisponível');
  });

  it('exclusão física pode concluir sem arquivos restantes e só expõe paths na prova interna', async () => {
    completeVerified.mockClear();
    const state = harness({
      files: [], tasks: [], planned: [], handoffs: [handoff()],
      panes: [{ missionId: 'mission-a906d36d', role: 'worker', agentName: 'Frontend', state: 'idle' }],
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { captureCandidate: async () => ({ fingerprint: 'deleted-candidate', complete: true, deletedPaths: ['old.ts'] }) },
    });
    let deletionPaths: readonly string[] | undefined;
    completeVerified.mockImplementationOnce((_scope, input) => {
      deletionPaths = getAutomaticCompletionProof(scope, state.liveMission)?.deletedArtifactPaths;
      Object.assign(state.liveMission, { status: 'done', result: input.result });
    });

    expect((await state.reconcile()).completed).toBe(true);
    expect(deletionPaths).toEqual(['old.ts']);
    expect(getAutomaticCompletionProof(scope, state.liveMission)).toBeNull();
  });

  it('mudança de intenção enquanto o scanner roda não conclui a missão atualizada', async () => {
    completeVerified.mockClear();
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate: async () => {
        state.liveMission.intentVersion = 2;
        return { kind: 'approved', evidenceId: 'old-review', note: 'versão anterior' };
      } },
    });

    expect(await state.reconcile()).toMatchObject({ action: 'wait', reason: 'review-candidate-changed' });
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('missões com mesmo ID em outro checkout não compartilham o voo', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const runAutoReviewGate = vi.fn(async () => {
      await pending;
      return { kind: 'approved' as const, evidenceId: 'proof', note: 'verificado' };
    });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });
    const first = state.reconcile();
    const second = state.reconcile({ ...scope, checkoutId: 'separate-checkout' });
    await vi.waitFor(() => expect(runAutoReviewGate).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
  });

  it('falha em uma tentativa libera o voo para a próxima revisão', async () => {
    const runAutoReviewGate = vi.fn()
      .mockRejectedValueOnce(new Error('scanner failed'))
      .mockResolvedValueOnce({ kind: 'approved', evidenceId: 'new-proof', note: 'verificado' });
    const state = boardDoneHarness({
      missionOverrides: { intentContract: civilianContract },
      depsExtras: { runAutoReviewGate },
    });
    await expect(state.reconcile()).rejects.toThrow('scanner failed');
    expect((await state.reconcile()).completed).toBe(true);
  });

  it('scanner indisponível + revisor no roster → abre revisor e espera', async () => {
    completeVerified.mockClear();
    blockUser.mockClear();
    const planned = storyPlan(2);
    const spawnReviewers = vi.fn(async () => ['QA']);
    const { reconcile } = harness({
      missionId: 'mission-civil-defer',
      files: ['server.js'],
      handoffs: [],
      tasks: planned.map((row) =>
        task({ id: row.taskId, title: row.agent.agentName, status: 'done' }),
      ),
      planned: [
        ...planned,
        {
          taskId: 't-qa',
          agentCategory: 'reviewer' as const,
          agent: { id: 'qa', agentName: 'QA', category: 'reviewer' as const },
        },
      ],
      missionOverrides: { intentContract: civilianContract },
      depsExtras: {
        spawnReviewers,
        runAutoReviewGate: async () => ({
          kind: 'defer-to-roster-review' as const,
        }),
      },
    });

    const result = await reconcile();
    expect(spawnReviewers).toHaveBeenCalledOnce();
    expect(result.action).toBe('wait');
    expect(result.spawnedReviewers).toEqual(['QA']);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('missão guiada com candidato congelado mantém seu gate próprio sem scanner duplicado', async () => {
    completeVerified.mockClear();
    blockUser.mockClear();
    const runAutoReviewGate = vi.fn();
    const planned = storyPlan(2);
    const { reconcile } = harness({
      missionId: 'mission-guided-board',
      files: ['server.js'],
      handoffs: [],
      tasks: planned.map((row) =>
        task({ id: row.taskId, title: row.agent.agentName, status: 'done' }),
      ),
      planned,
      missionOverrides: {
        intentContract: {
          ...civilianContract,
          orchestrationMode: 'guided',
        } as Mission['intentContract'],
      },
      depsExtras: { runAutoReviewGate, readFrozenReviewContext: () => ({ workflow: {} }) },
    });

    const result = await reconcile();
    expect(runAutoReviewGate).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
  });

  it('missão guiada sem candidato congelado usa reparo automático, sem exigir outro fluxo', async () => {
    completeVerified.mockClear();
    const runAutoReviewGate = vi.fn(async () => ({ kind: 'repair-dispatched' as const }));
    const state = boardDoneHarness({
      missionOverrides: { intentContract: { ...civilianContract, orchestrationMode: 'guided' } },
      depsExtras: { runAutoReviewGate, readFrozenReviewContext: () => null },
    });
    expect((await state.reconcile()).action).toBe('wait');
    expect(runAutoReviewGate).toHaveBeenCalledOnce();
    expect(completeVerified).not.toHaveBeenCalled();
  });
  });
});
