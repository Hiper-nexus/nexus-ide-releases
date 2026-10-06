// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import type { PaneSnapshot } from '../../shared/orch-types';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const h = vi.hoisted(() => ({
  discovered: null as null | ((scope: unknown, suite: unknown) => void),
  panes: [] as PaneSnapshot[],
  semantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  delivered: vi.fn(),
  judge: vi.fn(),
}));
vi.mock('./jev-mission-momentum', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-mission-momentum')>()),
  judgeMissionMomentum: h.judge,
}));
vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    onScope: (callback: (scope: unknown, suite: unknown) => void) => {
      h.discovered = callback;
      return () => {};
    },
  }),
}));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => h.panes,
  tapPendingSpawnStartFailure: () => () => {},
}));
vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => {
    const state = h.panes.find((pane) => pane.sessionId === sessionId)?.state;
    return state === 'busy' || state === 'idle' || state === 'spawning'
      ? state
      : null;
  },
  tapSessionTermination: () => () => {},
  getAgentSessionInfo: () => null,
  getRequestedTerminationOrigin: () => null,
  getSessionSpawnedAtMs: () => null,
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.semantic,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.delivered,
  redeliverPendingHandoffs: () => 0,
}));
vi.mock('./squad-store', () => ({ getSquad: () => null }));
vi.mock('./mission-event-emit', () => ({
  emitChefIdleAwaitingWorkers: () => {},
  emitMissionEvent: () => {},
}));
vi.mock('./mission-intent-events', () => ({
  emitMissionIntentEvent: () => {},
}));
vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({ blockTechnical: () => {} }),
}));
vi.mock('./zero-delivery-watchdog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./zero-delivery-watchdog')>()),
  decideZeroDeliveryWatchdog: () => ({ action: 'none' }),
}));
vi.mock('./nexus-task-fail-closed-recovery', () => ({
  flushAllNexusTaskFailClosedRetries: () => {},
}));
vi.mock('../observability/main-trace', () => ({ trace: () => {} }));

import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import { createTaskDispatchStore } from './task-dispatch-store';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { createScopedHandoffStore } from './handoff-store';
import { compileIntentContract } from '../../shared/mission-intent';
import {
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';

const NOW = 200_000_000;
let directory = '',
  runtime: ProjectRuntimeManager,
  clock = NOW;
beforeEach(async () => {
  await shutdownDelegationSupervisor();
  h.panes = [];
  h.semantic.mockReset();
  h.delivered.mockClear();
  h.judge.mockReset().mockResolvedValue({ kind: 'skipped' });
  clock = NOW;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-momentum-'));
  runtime = new ProjectRuntimeManager({
    baseDir: directory,
    appVersion: 'test',
  });
  prepareDelegationSupervisor();
});
afterEach(async () => {
  await shutdownDelegationSupervisor();
  runtime.closeAll();
  fs.rmSync(directory, { recursive: true, force: true });
});

function setup(
  options: {
    maxWorkers?: number;
    free?: boolean;
    readOnly?: boolean;
    approved?: boolean;
  } = {},
) {
  const scope = testProjectScope();
  let next = 0;
  const storeOptions = {
    now: () => clock,
    idFactory: (prefix: string) => `${prefix}-${++next}`,
  };
  const missions = createScopedMissionStore(runtime, scope, storeOptions);
  const contract = compileIntentContract({
    goal: 'Implementar as unidades existentes da missão',
    intentVersion: 1,
    freeAgentChoice: options.free !== false,
  });
  const created = missions.create({
    title: 'Esteira real',
    intentState: 'executing',
    intentVersion: 1,
    orchestratorSessionId: 'leader-session',
    intentContract: {
      ...contract,
      approvedAt: options.approved === false ? undefined : NOW - 1000,
      dispatchedAt: options.approved === false ? undefined : NOW - 500,
      budgets: { ...contract.budgets, maxWorkers: options.maxWorkers ?? 3 },
    },
  });
  const mission = missions.setStatus(created.id, 'running')!;
  const tasks = createScopedTaskStore(runtime, scope, storeOptions);
  const handoffs = createScopedHandoffStore(runtime, scope, storeOptions);
  const taskDispatches = createTaskDispatchStore(runtime, scope, storeOptions);
  const missionPanes = createScopedMissionPaneStore(
    runtime,
    scope,
    storeOptions,
  );
  const suite = {
    scope,
    missions,
    tasks,
    handoffs,
    taskDispatches,
    missionPanes,
  } as ProjectDomainStoreSuite;
  h.discovered!(scope, suite);
  h.panes = [
    {
      paneId: 'leader',
      sessionId: 'leader-session',
      missionId: mission.id,
      role: 'orchestrator',
      kind: 'cli-agent',
      state: 'busy',
      title: 'Maestro',
      scope,
      readOnly: options.readOnly ?? false,
    },
    {
      paneId: 'idle-helper',
      sessionId: 'idle-session',
      missionId: mission.id,
      role: 'worker',
      kind: 'cli-agent',
      state: 'idle',
      title: 'Helper idle',
      scope,
    },
  ];
  h.semantic.mockImplementation((sessionId) => ({
    status: sessionId === 'leader-session' ? 'working' : 'idle',
    updatedAt: clock,
  }));
  const notices = () =>
    handoffs
      .list({ missionId: mission.id, includeDelivered: true })
      .filter((row) => row.summary.startsWith(`[momentum:${mission.id}]`));
  const scan = async (after: number) => {
    clock = NOW + after;
    await reconcileDelegationSupervisor(clock);
  };
  return { mission, tasks, handoffs, notices, scan, suite };
}

describe('real supervisor momentum queue', () => {
  it('a model wait-gate cannot suppress registered independent work', async () => {
    const c = setup();
    const ready = c.tasks.create({ missionId: c.mission.id, title: 'Independent work' });
    h.judge.mockResolvedValue({ kind: 'judged', action: 'wait-gate', confidence: 0.9 });
    await c.scan(0);
    await c.scan(30_000);
    expect(c.notices()).toHaveLength(1);
    expect(c.notices()[0].summary).toContain(ready.id);
    expect(h.delivered).toHaveBeenCalledTimes(1);
  });

  it.each(['status', 'leader', 'shutdown', 'task', 'reservation'] as const)('discards a pending judgment after %s changes', async (change) => {
    const c = setup();
    const task = c.tasks.create({ missionId: c.mission.id, title: 'Independent work' });
    await c.scan(0);
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let resolveJudge!: (value: unknown) => void;
    h.judge.mockImplementationOnce(() => {
      started();
      return new Promise(resolve => { resolveJudge = resolve; });
    });
    const scan = c.scan(30_000).catch(() => {});
    await entered;
    let stopped: Promise<void> | undefined;
    if (change === 'status') c.suite.missions.setStatus(c.mission.id, 'blocked');
    if (change === 'leader') h.panes[0].sessionId = 'replacement-session';
    if (change === 'shutdown') stopped = shutdownDelegationSupervisor();
    if (change === 'task') c.tasks.update(task.id, { status: 'done' });
    if (change === 'reservation') c.suite.missionPanes.record({ missionId: c.mission.id, adapterId: 'codex', title: 'Pending spawn', role: 'worker' });
    resolveJudge({ kind: 'skipped' });
    await scan;
    await stopped;
    expect(c.notices()).toHaveLength(0);
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it('registered ready task and idle helper cause a directive after thirty seconds, not twenty minutes', async () => {
    const c = setup();
    const upstream = c.tasks.create({
      missionId: c.mission.id,
      title: 'Upstream',
    });
    c.tasks.update(upstream.id, { status: 'running' });
    const waiting = c.tasks.create({
      missionId: c.mission.id,
      title: 'Depends on upstream',
      detail: `[plan-meta]${JSON.stringify({ dependsOn: [upstream.id] })}`,
    });
    const ready = c.tasks.create({
      missionId: c.mission.id,
      title: 'Independent registered work',
    });
    await c.scan(0);
    await c.scan(15000);
    expect(c.notices()).toHaveLength(0);
    await c.scan(30000);
    expect(c.notices()).toHaveLength(1);
    expect(c.notices()[0].summary).toContain(ready.id);
    expect(c.notices()[0].summary).not.toContain(waiting.id);
    expect(c.notices()[0].summary).toContain('2 vagas do orçamento da missão');
    expect(c.notices()[0].summary).toContain('0 workers trabalhando');
    expect(c.notices()[0].summary).toContain('um por vez');
    expect(h.delivered).toHaveBeenCalledTimes(1);
    await c.scan(45000);
    await c.scan(60000);
    await c.scan(120000);
    expect(c.notices()).toHaveLength(1);
    // Persisted receipt still fences a brand-new supervisor process lifecycle.
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
    h.discovered!(c.suite.scope, c.suite);
    await c.scan(150000);
    await c.scan(180000);
    expect(c.notices()).toHaveLength(1);
  });

  it('newly completed dependency permits a new wave after the progress cooldown', async () => {
    const c = setup();
    const upstream = c.tasks.create({
      missionId: c.mission.id,
      title: 'Upstream',
    });
    c.tasks.update(upstream.id, { status: 'running' });
    const next = c.tasks.create({
      missionId: c.mission.id,
      title: 'Next wave',
      detail: `[plan-meta]${JSON.stringify({ dependsOn: [upstream.id] })}`,
    });
    c.tasks.create({
      missionId: c.mission.id,
      title: 'Current independent work',
    });
    await c.scan(0);
    await c.scan(30000);
    c.tasks.update(upstream.id, { status: 'done' });
    await c.scan(45000);
    expect(c.notices()).toHaveLength(1);
    await c.scan(90000);
    expect(c.notices()).toHaveLength(2);
    expect(c.notices().at(-1)!.summary).toContain(next.id);
  });

  it.each([
    { maxWorkers: 1 },
    { maxWorkers: 0 },
    { readOnly: true },
    { approved: false },
    { free: false },
  ])(
    'keeps real backlog quiet without available authority/capacity %j',
    async (options) => {
      const c = setup(options);
      c.tasks.create({ missionId: c.mission.id, title: 'Existing work' });
      await c.scan(0);
      await c.scan(30000);
      await c.scan(3600000);
      expect(c.notices()).toHaveLength(0);
    },
  );

  it('pre-bind reservations consume the same worker budget as the spawn gate', async () => {
    const c = setup();
    c.tasks.create({ missionId: c.mission.id, title: 'Existing work' });
    c.suite.missionPanes.record({
      missionId: c.mission.id,
      adapterId: 'codex',
      title: 'reserved-one',
      role: 'worker',
    });
    c.suite.missionPanes.record({
      missionId: c.mission.id,
      adapterId: 'codex',
      title: 'reserved-two',
      role: 'worker',
    });
    c.suite.missionPanes.record({
      missionId: c.mission.id,
      adapterId: 'codex',
      title: 'reserved-three',
      role: 'worker',
    });
    await c.scan(0);
    await c.scan(30000);
    expect(c.notices()).toHaveLength(0);
  });

  it('a leader bound to another checkout cannot receive this execution directive', async () => {
    const c = setup();
    c.tasks.create({ missionId: c.mission.id, title: 'Existing work' });
    h.panes[0].scope = { ...c.suite.scope, checkoutId: 'another-checkout' };
    await c.scan(0);
    await c.scan(30000);
    expect(c.notices()).toHaveLength(0);
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it('no registered work or only unmet dependencies never creates a made-up directive', async () => {
    const c = setup();
    await c.scan(0);
    await c.scan(3600000);
    expect(c.notices()).toHaveLength(0);
    c.tasks.create({
      missionId: c.mission.id,
      title: 'Unprovable dependency',
      detail: '[plan-meta]{"dependsOn":["missing"]}',
    });
    await c.scan(3615000);
    await c.scan(3650000);
    expect(c.notices()).toHaveLength(0);
  });
});
