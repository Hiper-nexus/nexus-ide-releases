import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: () => null,
  getSessionCwd: () => null,
  tapSessionExit: () => () => {},
  tapSessionState: () => () => {},
}));

vi.mock('./gate', () => ({
  getContextBySession: () => null,
}));

vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: () => () => {},
}));

import { compileIntentContract } from '../../shared/mission-intent';
import type { Squad } from '../../shared/orch-types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import {
  boardProgressFromSealedTasks,
  sealFastLaneListedStoryPlan,
} from './mission-story-plan';
import { createScopedTaskStore } from './task-store';
import {
  __resetWorkerDeliveryBoardForTests,
  handleWorkerPaneDone,
  markSessionSealedBoardCredited,
  noteWorkerDeliveryBaseline,
  reconcileSealedBoardFromDisk,
  type WorkerDeliveryBoardDeps,
} from './worker-delivery-board';
import {
  collectFilesModifiedSince,
  snapshotWorkerDeliveryBaseline,
} from './worker-delivery-evidence';

let baseDir = '';
let repo = '';
const managers: ProjectRuntimeManager[] = [];

const squad: Squad = {
  id: 'delivery-squad',
  name: 'Delivery squad',
  createdAt: '2026-07-23T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: 'Coordinate.',
  agents: [
    {
      id: 'orchestrator',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
      model: 'claude-opus-4-1',
    },
    {
      id: 'api-worker',
      agentName: 'API Worker',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.3-codex',
    },
  ],
};

function twentyStoryObjective(): string {
  return [
    'Monte um SaaS de waitlist com estas stories:',
    ...Array.from(
      { length: 20 },
      (_, index) => `${index + 1}. Story ${index + 1} da waitlist`,
    ),
  ].join('\n');
}

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' });
}

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  __resetWorkerDeliveryBoardForTests();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-delivery-board-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-delivery-cwd-'));
  git('init -b main');
  git('config user.email test@nexus.dev');
  git('config user.name Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# seed\n');
  git('add README.md');
  git('commit -m seed');
});

afterEach(() => {
  __resetWorkerDeliveryBoardForTests();
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function sealBoard(
  handoffs: ReadonlyArray<{
    readonly status: string;
    readonly sessionId?: string;
    readonly workerIncarnationId?: string;
  }> = [],
  objective = twentyStoryObjective(),
) {
  const runtimeManager = manager();
  const scope = testProjectScope({ rootRealPath: repo });
  const missions = createScopedMissionStore(runtimeManager, scope);
  const tasks = createScopedTaskStore(runtimeManager, scope, { now: () => 200 });
  const contract = compileIntentContract({
    goal: objective,
    intentVersion: 1,
  });
  const mission = missions.create({
    title: 'Waitlist',
    description: objective,
    squadId: squad.id,
    intentVersion: 1,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const stores = {
    missions,
    tasks,
    handoffs: {
      list: () => handoffs,
    },
  } as unknown as Parameters<typeof sealFastLaneListedStoryPlan>[0];
  sealFastLaneListedStoryPlan(stores, missions.get(mission.id)!, squad);
  return { mission, missions, tasks, stores, scope };
}

function depsFor(stores: ReturnType<typeof sealBoard>['stores']): WorkerDeliveryBoardDeps {
  return {
    getAgent: () => null,
    getCwd: () => repo,
    getStores: () => stores as never,
    snapshotBaseline: (cwd) => snapshotWorkerDeliveryBaseline(cwd),
    collectFilesModified: (cwd, baseline) =>
      collectFilesModifiedSince(cwd, baseline),
  };
}

function workerAgent(missionId: string) {
  return {
    sessionId: 'pty-writer-1',
    adapterId: 'codex',
    cwd: repo,
    scope: testProjectScope({ rootRealPath: repo }),
    source: 'legacy-squad' as const,
    role: 'worker' as const,
    missionId,
    agentName: 'Writer 1',
    workerIncarnationId: 'inc-1',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
  };
}

describe('handleWorkerPaneDone → board selado', () => {
  it('worker pane done + files-modified no disco incrementa o board (1/20)', () => {
    const { mission, tasks, stores } = sealBoard();
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });

    const deps = depsFor(stores);
    noteWorkerDeliveryBaseline('pty-writer-1', repo, deps);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'waitlist.ts'), 'export const ok = true;\n');

    const result = handleWorkerPaneDone(
      {
        sessionId: 'pty-writer-1',
        agent: workerAgent(mission.id),
        source: 'pty-exit',
        summary: 'Writer 1 entregou a landing.',
      },
      deps,
    );

    expect(result.filesModified).toEqual(['src/waitlist.ts']);
    expect(result.advancedTaskId).toBeTruthy();
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 1,
      total: 20,
    });
  });

  it('worker done + 0 files + sem handoff deixa o board 0/20', () => {
    const { mission, tasks, stores } = sealBoard();
    const deps = depsFor(stores);
    noteWorkerDeliveryBaseline('pty-writer-1', repo, deps);

    const result = handleWorkerPaneDone(
      {
        sessionId: 'pty-writer-1',
        agent: workerAgent(mission.id),
        source: 'pty-exit',
      },
      deps,
    );

    expect(result.advancedTaskId).toBeNull();
    expect(result.filesModified).toEqual([]);
    expect(result.reason).toMatch(/0 files-modified/);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });

  it('PTY exit + ficheiro só no mtime (gitignored) sem SUCCESS avança a próxima aberta', () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.local\n');
    git('add .gitignore');
    git('commit -m ignore');
    const { mission, tasks, stores } = sealBoard();
    const deps = depsFor(stores);
    const baseline = noteWorkerDeliveryBaseline('pty-writer-1', repo, deps);
    const ignored = path.join(repo, 'landing.local');
    fs.writeFileSync(ignored, 'ok\n');
    const later = new Date((baseline?.observedAt ?? Date.now()) + 5_000);
    fs.utimesSync(ignored, later, later);

    const result = handleWorkerPaneDone(
      {
        sessionId: 'pty-writer-1',
        agent: workerAgent(mission.id),
        source: 'pty-exit',
        summary: 'Writer 1 entregou a landing.',
      },
      deps,
    );

    expect(result.filesModified).toEqual(['landing.local']);
    expect(result.advancedTaskId).toBeTruthy();
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 1,
      total: 20,
    });
  });

  it('recibo SUCCESS da sessão + files-modified não fecha uma segunda task', () => {
    const { mission, tasks, stores } = sealBoard([
      { status: 'success', sessionId: 'pty-writer-1' },
    ]);
    const deps = depsFor(stores);
    noteWorkerDeliveryBaseline('pty-writer-1', repo, deps);
    fs.writeFileSync(path.join(repo, 'extra.ts'), 'export {}\n');

    const result = handleWorkerPaneDone(
      {
        sessionId: 'pty-writer-1',
        agent: workerAgent(mission.id),
        source: 'pty-exit',
      },
      deps,
    );

    expect(result.advancedTaskId).toBeNull();
    expect(result.reason).toMatch(/recibo SUCCESS/);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });

  it('sessão já creditada pelo MCP não fecha uma segunda task no PTY exit', () => {
    const { mission, tasks, stores } = sealBoard();
    const deps = depsFor(stores);
    noteWorkerDeliveryBaseline('pty-writer-1', repo, deps);
    markSessionSealedBoardCredited('pty-writer-1');
    fs.writeFileSync(path.join(repo, 'extra.ts'), 'export {}\n');

    const result = handleWorkerPaneDone(
      {
        sessionId: 'pty-writer-1',
        agent: workerAgent(mission.id),
        source: 'pty-exit',
      },
      deps,
    );

    expect(result.advancedTaskId).toBeNull();
    expect(result.reason).toMatch(/já creditou/);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });
});

describe('reconcileSealedBoardFromDisk — first-wave sem PTY death', () => {
  it('17 arquivos no disco com board 0/N incrementa sem pane exit', () => {
    const { mission, tasks, stores } = sealBoard();
    const deps = depsFor(stores);
    fs.mkdirSync(path.join(repo, 'public'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'server.js'), 'listen(4341)\n');
    fs.writeFileSync(path.join(repo, 'public', 'index.html'), '<html></html>\n');
    for (let i = 0; i < 15; i += 1) {
      fs.writeFileSync(path.join(repo, `file-${i}.txt`), 'ok\n');
    }

    const result = reconcileSealedBoardFromDisk(
      { stores, missionId: mission.id, cwd: repo },
      deps,
    );

    expect(result.filesModified.length).toBeGreaterThan(0);
    expect(result.advancedTaskIds.length).toBeGreaterThan(0);
    expect(
      boardProgressFromSealedTasks(tasks.list(mission.id)).completed,
    ).toBeGreaterThan(0);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id)).total).toBe(20);
  });

  it('cwd limpo sem handoff SUCCESS não mexe no board', () => {
    const { mission, tasks, stores } = sealBoard();
    const result = reconcileSealedBoardFromDisk(
      { stores, missionId: mission.id, cwd: repo },
      depsFor(stores),
    );
    expect(result.advancedTaskIds).toEqual([]);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });

  it('missão com recibo SUCCESS não reconcilia mais tasks pelos ficheiros dirty', () => {
    const { mission, tasks, stores } = sealBoard([
      { status: 'success', sessionId: 'pty-writer-1' },
    ]);
    fs.writeFileSync(path.join(repo, 'server.js'), 'listen(4341)\n');

    const result = reconcileSealedBoardFromDisk(
      { stores, missionId: mission.id, cwd: repo },
      depsFor(stores),
    );

    expect(result.advancedTaskIds).toEqual([]);
    expect(result.reason).toMatch(/recibo SUCCESS/);
    expect(boardProgressFromSealedTasks(tasks.list(mission.id))).toEqual({
      completed: 0,
      total: 20,
    });
  });
});

describe('reconcileSealedBoardFromDisk — pasta pending-with-file (sem sqlite)', () => {
  beforeEach(() => {
    __resetWorkerDeliveryBoardForTests();
  });

  it('067 unique file já na pasta fecha Landing após recibo SUCCESS', () => {
    const objective = [
      '1. Landing',
      ...Array.from(
        { length: 15 },
        (_, index) => `${index + 2}. Story ${index + 2} da waitlist`,
      ),
      '17. Admin lista emails',
      '18. Contador da fila',
      '19. Extra leftover',
      '20. Favicon e OG',
    ].join('\n');
    const leftover = new Set([
      'Landing',
      'Admin lista emails',
      'Contador da fila',
      'Favicon e OG',
    ]);
    const mission = {
      id: 'mission-067-pasta',
      title: 'SaaS 067',
      description: objective,
      status: 'running' as const,
      intentVersion: 1,
      intentState: 'executing' as const,
      squadId: squad.id,
      intentContract: compileIntentContract({ goal: objective, intentVersion: 1 }),
    };
    const taskRows: Array<{
      id: string;
      title: string;
      status: string;
      plannerId: string;
    }> = [];
    const stores = {
      missions: { get: () => mission },
      tasks: {
        hasPlan: () => taskRows.length > 0,
        list: () => taskRows,
        listPlannedTasks: () =>
          taskRows.map((task) => ({
            taskId: task.id,
            plannerId: task.plannerId,
            agentRef: 'api-worker',
            agent: {
              id: 'api-worker',
              agentName: 'API Worker',
              category: 'executor' as const,
            },
            agentCategory: 'executor' as const,
            task,
          })),
        createPlanAtomically: (input: {
          rows: readonly { plannerId: string; title: string }[];
        }) => {
          taskRows.length = 0;
          for (const row of input.rows) {
            taskRows.push({
              id: `t-${row.plannerId}`,
              title: row.title,
              status: leftover.has(row.title) ? 'pending' : 'done',
              plannerId: row.plannerId,
            });
          }
          return [...taskRows];
        },
        advanceSealedTaskStatus: (id: string, status: string) => {
          const row = taskRows.find((task) => task.id === id);
          if (row) row.status = status;
          return row ?? null;
        },
      },
      handoffs: {
        list: () => [{ status: 'success', sessionId: 'pty-writer-1' }],
      },
    };
    sealFastLaneListedStoryPlan(stores as never, mission as never, squad);
    expect(boardProgressFromSealedTasks(taskRows)).toEqual({
      completed: 16,
      total: 20,
    });

    const pastaFiles = ['story-01-landing.html', '05-admin-lista-emails.js'];
    const result = reconcileSealedBoardFromDisk(
      { stores: stores as never, missionId: mission.id, cwd: '/tmp/067' },
      {
        snapshotBaseline: () =>
          Object.freeze({
            cwd: '/tmp/067',
            headSha: 'abc',
            dirtyPaths: Object.freeze(pastaFiles),
            observedAt: 1,
          }),
        collectFilesModified: (_cwd, baseline) =>
          baseline.dirtyPaths.length === 0 ? [...pastaFiles] : [],
      },
    );

    expect(result.advancedTaskIds.length).toBeGreaterThan(0);
    expect(taskRows.find((row) => row.title === 'Landing')?.status).toBe('done');
    expect(
      taskRows.find((row) => row.title === 'Admin lista emails')?.status,
    ).toBe('done');
    expect(boardProgressFromSealedTasks(taskRows).completed).toBe(18);
  });
});
