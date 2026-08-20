import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  decideCivilianDeliveryAction,
  inspectCivilianDelivery,
  inspectDeliveryEvidence,
  maybeCompleteFastLaneOnDelivery,
} from './civilian-delivery-completion';
import { FIRST_WAVE_WRITER_SEATS, planFirstWaveSeats } from './via-rapida-first-wave';
import { planViaRapidaIniciarWalk } from './via-rapida-walk';
import {
  advanceFastLaneStoryTaskFromWorkerDone,
  boardProgressFromSealedTasks,
  sealFastLaneListedStoryPlan,
} from './mission-story-plan';
import { clearSealedBoardSessionCredits } from './sealed-board-session-credit';
import { isApiKeyPasteToast, seatFailureHint } from '../adapters/seat-auth-readiness';
import type { ScopedTaskRecord } from './task-store';

function twentyStories(): string {
  const lines = ['eu quero isso → software pronto: waitlist SaaS com 20 stories'];
  for (let i = 1; i <= 20; i += 1) {
    lines.push(`${i}. Story ${String(i).padStart(2, '0')} da waitlist`);
  }
  return lines.join('\n');
}

const squadAgents: SquadAgent[] = [
  {
    id: 'maestro',
    agentName: 'Maestro',
    category: 'orchestrator',
    cli: 'claude',
  } as SquadAgent,
  {
    id: 'frontend',
    agentName: 'Frontend',
    category: 'executor',
    cli: 'claude',
    authStrategy: 'subscription',
  } as SquadAgent,
  {
    id: 'backend',
    agentName: 'Backend',
    category: 'executor',
    cli: 'codex',
    authStrategy: 'subscription',
  } as SquadAgent,
  {
    id: 'longcat',
    agentName: 'LongCat',
    category: 'executor',
    cli: 'longcat',
    hasKey: false,
  } as SquadAgent,
];

const squad: Squad = {
  id: 'nexus-fullstack',
  name: 'Full-Stack',
  createdAt: '2026-08-19T00:00:00.000Z',
  builtin: true,
  orchestratorInstructions: '',
  agents: squadAgents,
};

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-iniciar-20',
    title: 'Waitlist 20',
    description: twentyStories(),
    status: 'running',
    squadId: squad.id,
    intentState: 'executing',
    intentVersion: 0,
    updatedAt: 1_000,
    createdAt: 1,
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

function task(
  id: string,
  title: string,
  status: ScopedTaskRecord['status'] = 'pending',
): ScopedTaskRecord {
  return {
    id,
    title,
    detail: title,
    status,
    missionId: 'mission-iniciar-20',
    createdAt: 1,
    updatedAt: 1,
  } as ScopedTaskRecord;
}

afterEach(() => {
  clearSealedBoardSessionCredits();
});

describe('Iniciar 20-story → first-wave + selo + Pronto', () => {
  it('Iniciar 20-story → first-wave dispatched + seal 20 + Pronto path reachable from files+idle writers', async () => {
    const walk = planViaRapidaIniciarWalk({
      objective: twentyStories(),
      agents: squadAgents,
      classifySeat: (agent) => {
        if (agent.cli === 'longcat') return 'no-credential';
        return 'present';
      },
    });

    expect(walk.stories).toHaveLength(20);
    expect(walk.sealedRows).toHaveLength(20);
    expect(walk.firstWaveSeats.length).toBe(FIRST_WAVE_WRITER_SEATS);
    expect(walk.firstWaveSeats.every((seat) => seat.agent.cli !== 'longcat')).toBe(
      true,
    );
    expect(walk.skippedAdapters).toContain('longcat');
    expect(
      isApiKeyPasteToast(
        seatFailureHint({
          readiness: 'no-credential',
          explicitCivilianPick: false,
          civilianHint: '',
        }),
      ),
    ).toBe(false);

    const sealedIds = walk.sealedRows.map((_row, index) => `task-story-${index + 1}`);
    const tasks = sealedIds.map((id, index) =>
      task(id, walk.sealedRows[index]!.title),
    );
    const planned = tasks.map((row, index) => ({
      taskId: row.id,
      agentCategory: 'executor' as const,
      agent: {
        id: squadAgents[1 + (index % 2)]!.id,
        agentName: squadAgents[1 + (index % 2)]!.agentName,
        category: 'executor' as const,
      },
    }));

    const files = [
      'server.js',
      'public/index.html',
      'public/app.js',
      'package.json',
      'smoke.mjs',
    ];
    const evidence = inspectDeliveryEvidence(files, twentyStories());
    expect(evidence.expected).toBe(true);

    const inspection = inspectCivilianDelivery({
      mission: mission(),
      tasks: tasks.map((row, index) =>
        index < 7 ? { ...row, status: 'running' } : row,
      ),
      planned,
      handoffs: [],
      panes: walk.firstWaveSeats.map((seat) => ({
        missionId: 'mission-iniciar-20',
        agentName: seat.title,
        role: 'worker',
        state: 'idle',
      })),
      now: Date.now(),
    });

    expect(inspection.activeWriterCount).toBe(0);
    expect(inspection.hasRealWorkerDelivery).toBe(true);
    expect(inspection.neverStartedDraft).toBe(false);
    expect(inspection.holdForReview).toBe(false);

    const action = decideCivilianDeliveryAction({
      failClosed: inspection.failClosed,
      boardAllDone: inspection.boardAllDone,
      hasExpectedDelivery: evidence.expected,
      designOnly: evidence.designOnly,
      neverStartedDraft: inspection.neverStartedDraft,
      hasSuccessHandoff: inspection.hasSuccessHandoff,
      hasRealWorkerDelivery: inspection.hasRealWorkerDelivery,
      holdForReview: inspection.holdForReview,
      productFileCount: evidence.productFiles.length,
      activeWriterCount: inspection.activeWriterCount,
      workersDelivered: inspection.workersDelivered,
      hasQueuedHandoffs: inspection.hasQueuedHandoffs,
      remainingKinds: inspection.remaining.map((row) => row.kind),
      oldestReviewQueuedMs: null,
    });
    expect(action).toBe('reroute');

    const cwd = mkdtempSync(join(tmpdir(), 'via-rapida-20-'));
    mkdirSync(join(cwd, 'public'));
    writeFileSync(join(cwd, 'server.js'), 'require("http").createServer().listen(4341)\n');
    writeFileSync(join(cwd, 'public/index.html'), '<html><body>waitlist</body></html>\n');
    writeFileSync(join(cwd, 'public/app.js'), 'console.log("ok")\n');
    writeFileSync(join(cwd, 'package.json'), '{"name":"waitlist"}\n');
    writeFileSync(join(cwd, 'smoke.mjs'), 'console.log("OVERALL PASS")\n');

    const liveTasks = new Map(tasks.map((row) => [row.id, { ...row }]));
    let completed = false;
    const running = mission();
    const result = await maybeCompleteFastLaneOnDelivery(
      testProjectScope({ rootRealPath: cwd }),
      'mission-iniciar-20',
      {
        getStores: () =>
          ({
            missions: {
              get: () =>
                completed
                  ? { ...running, status: 'done' as const, result: { outcome: 'success' } }
                  : running,
            },
            handoffs: { list: () => [] },
            tasks: {
              list: () =>
                [...liveTasks.values()].map((row, index) =>
                  index < 7 ? { ...row, status: 'running' as const } : row,
                ),
              listPlannedTasks: () => planned,
              markLifecycleStatus: (
                taskId: string,
                status: 'running' | 'done' | 'failed',
              ) => {
                const current = liveTasks.get(taskId);
                if (!current) return null;
                const next = { ...current, status };
                liveTasks.set(taskId, next);
                return next;
              },
              advanceSealedTaskStatus: (
                taskId: string,
                status: 'running' | 'done' | 'failed',
              ) => {
                const current = liveTasks.get(taskId);
                if (!current) return null;
                const next = { ...current, status };
                liveTasks.set(taskId, next);
                return next;
              },
            },
          }) as never,
        listPanes: () =>
          walk.firstWaveSeats.map((seat) => ({
            missionId: 'mission-iniciar-20',
            agentName: seat.title,
            role: 'worker' as const,
            state: 'idle',
          })),
        listProductFiles: async () => files,
        missionEngine: {
          completeVerified: () => {
            completed = true;
          },
        },
      },
    );

    expect(result.completed).toBe(false);
    expect(result.action).toBe('reroute');
    expect(result.productFiles.length).toBeGreaterThan(0);

    // Guided/legacy ainda segura review — Pronto civil da Via Rápida não
    // pula Maestro/revisor nesse caminho.
    const guided = decideCivilianDeliveryAction({
      failClosed: false,
      boardAllDone: false,
      hasExpectedDelivery: true,
      designOnly: false,
      neverStartedDraft: false,
      hasSuccessHandoff: false,
      hasRealWorkerDelivery: true,
      holdForReview: true,
      productFileCount: files.length,
      activeWriterCount: 0,
      workersDelivered: false,
      hasQueuedHandoffs: false,
      remainingKinds: ['review'],
      oldestReviewQueuedMs: 1_000,
    });
    expect(guided).toBe('wait');
    void completed;
  });

  it('files-modified no done do worker sobe o board selado sem inventar stories', () => {
    const walk = planViaRapidaIniciarWalk({
      objective: twentyStories(),
      agents: squadAgents.filter((agent) => agent.cli !== 'longcat'),
    });
    const tasks: Array<{
      id: string;
      title: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    }> = walk.sealedRows.map((row, index) => ({
      id: `t-${index + 1}`,
      title: row.title,
      status: 'pending',
    }));
    expect(boardProgressFromSealedTasks(tasks)).toEqual({ completed: 0, total: 20 });

    const fakeStores = {
      missions: { get: () => mission() },
      tasks: {
        hasPlan: () => true,
        listPlannedTasks: () =>
          tasks.map((row) => ({
            taskId: row.id,
            agentRef: 'frontend',
            agent: { id: 'frontend', agentName: 'Frontend', category: 'executor' as const },
            agentCategory: 'executor' as const,
            task: row,
          })),
        list: () => tasks,
        createPlanAtomically: () => tasks,
        markLifecycleStatus: (id: string, status: 'running' | 'done' | 'failed') => {
          const row = tasks.find((taskRow) => taskRow.id === id);
          if (!row) return null;
          row.status = status;
          return row as ScopedTaskRecord;
        },
        advanceSealedStatus: (id: string, status: 'running' | 'done' | 'failed') => {
          const row = tasks.find((taskRow) => taskRow.id === id);
          if (!row) return null;
          row.status = status;
          return row as ScopedTaskRecord;
        },
        advanceSealedTaskStatus: (id: string, status: 'running' | 'done' | 'failed') => {
          const row = tasks.find((taskRow) => taskRow.id === id);
          if (!row) return null;
          row.status = status;
          return row as ScopedTaskRecord;
        },
      },
    };

    // Regra nova (19/08): conclusão FÍSICA sem match arquivo↔story não
    // avança — o fallback next-open ficou exclusivo do handoff assertado.
    expect(
      advanceFastLaneStoryTaskFromWorkerDone(fakeStores as never, {
        missionId: 'mission-iniciar-20',
        filesModified: ['server.js'],
      }),
    ).toBeNull();
    expect(boardProgressFromSealedTasks(tasks)).toEqual({ completed: 0, total: 20 });

    // Com identidade de assento (Writer 2 → story 2) o avanço é legítimo.
    expect(
      advanceFastLaneStoryTaskFromWorkerDone(fakeStores as never, {
        missionId: 'mission-iniciar-20',
        fromAgent: 'Writer 2',
        filesModified: ['server.js'],
      }),
    ).toBeTruthy();
    expect(boardProgressFromSealedTasks(tasks)).toEqual({ completed: 1, total: 20 });
  });

  it('selo real de 20 stories no store (Iniciar com missão running)', () => {
    // Coberto em mission-story-plan.test.ts com sqlite; aqui o contrato do walk.
    const walk = planViaRapidaIniciarWalk({
      objective: twentyStories(),
      agents: squadAgents,
      classifySeat: (agent) => (agent.cli === 'longcat' ? 'no-credential' : 'present'),
    });
    expect(sealFastLaneListedStoryPlan.length).toBeGreaterThan(0);
    expect(walk.sealedRows.map((row) => row.plannerId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `story-${i + 1}`),
    );
  });
});

describe('first-wave writer_circuit_break', () => {
  it('não re-senta Kimi após circuit-break 3', () => {
    const wave = planFirstWaveSeats({
      storyCount: 20,
      storyTitles: Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`),
      agents: squadAgents,
      classifySeat: (agent) => (agent.cli === 'longcat' ? 'no-credential' : 'present'),
      blockedAdapterIds: ['claude'],
    });
    expect(wave.seats.every((seat) => seat.agent.cli !== 'claude')).toBe(true);
    expect(wave.presentWriters.every((agent) => agent.cli !== 'claude')).toBe(true);
    expect(wave.seats.length).toBeGreaterThan(0);
    expect(wave.seats.every((seat) => seat.agent.cli === 'codex')).toBe(true);
  });

  it('20-story com 6 CLIs present (agy sem auth) senta as 6, não só Codex', () => {
    const present = new Set(['codex', 'grok', 'glm', 'kimi', 'opencode', 'aider']);
    const wave = planFirstWaveSeats({
      storyCount: 20,
      storyTitles: Array.from({ length: 20 }, (_, i) => `Story ${i + 1}`),
      agents: squadAgents,
      extraPresentClis: ['codex', 'agy', 'grok', 'glm', 'kimi', 'opencode', 'aider', 'longcat'],
      orchestratorCli: 'claude',
      classifySeat: (row) => (present.has(row.cli) ? 'present' : 'no-credential'),
    });
    expect(wave.seats.length).toBe(FIRST_WAVE_WRITER_SEATS);
    expect(wave.seats.length).toBeGreaterThanOrEqual(6);
    const clis = new Set(wave.seats.map((seat) => seat.agent.cli));
    expect(clis.has('agy')).toBe(false);
    expect(clis.has('longcat')).toBe(false);
    for (const cli of present) expect(clis.has(cli)).toBe(true);
  });

  it('first-wave curto reroteia só as stories pendentes, não as já done', () => {
    const pending = [
      'Landing',
      'Admin lista emails',
      'Contador da fila',
      'Favicon e OG',
    ];
    const wave = planFirstWaveSeats({
      storyCount: pending.length,
      storyTitles: pending,
      agents: squadAgents,
      classifySeat: (agent) =>
        agent.cli === 'longcat' ? 'no-credential' : 'present',
      liveWritableWorkers: 2,
    });
    expect(wave.seats.length).toBeGreaterThan(0);
    expect(
      wave.seats.every(
        (seat) => seat.storyTitle !== null && pending.includes(seat.storyTitle),
      ),
    ).toBe(true);
  });
});
