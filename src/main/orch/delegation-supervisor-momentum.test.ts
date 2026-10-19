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
  awaitingOperator: vi.fn((_sessionId: string) => false),
  delivered: vi.fn(),
  event: vi.fn(),
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
  isAgentAwaitingOperator: h.awaitingOperator,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.delivered,
  redeliverPendingHandoffs: () => 0,
}));
vi.mock('./squad-store', () => ({ getSquad: () => null }));
vi.mock('./mission-event-emit', () => ({
  emitChefIdleAwaitingWorkers: () => {},
  emitMissionEvent: h.event,
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
import { clearCompletionRequest, recordOperatorTabCompletionRequest } from './operator-tab-completion';
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
import { MOMENTUM_OPERATOR_WAIT_CEILING_MS } from './mission-momentum-watchdog';

const NOW = 200_000_000;
let directory = '',
  runtime: ProjectRuntimeManager,
  clock = NOW;
beforeEach(async () => {
  await shutdownDelegationSupervisor();
  h.panes = [];
  h.semantic.mockReset();
  h.awaitingOperator.mockReset().mockReturnValue(false);
  h.delivered.mockClear();
  h.event.mockClear();
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

/** O Maestro perguntou via nexus_clarify: o ledger durável tem a questão. */
function askOperator(c: ReturnType<typeof setup>) {
  return c.handoffs.submit({
    missionId: c.mission.id,
    sessionId: 'leader-session',
    fromAgent: 'Maestro',
    status: 'progress',
    summary: 'Pergunta ao operador: Qual caminho?',
    artifacts: [
      {
        kind: 'nexus-clarify-question',
        schemaVersion: 1,
        clarify: {
          question: 'Qual caminho?',
          chips: [
            { id: 'opt-1', label: 'Sim' },
            { id: 'opt-2', label: 'Não' },
          ],
          allowFreeform: false,
        },
      },
    ],
  });
}

function reminderEvents(c: ReturnType<typeof setup>) {
  return h.event.mock.calls.filter(
    ([scope, input]) =>
      scope === c.suite.scope &&
      (input as { payload?: { kind?: string } }).payload?.kind ===
        'momentum-awaiting-operator',
  );
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
    expect(h.event).not.toHaveBeenCalled();
  });

  it('a completion request recorded during the judgment await discards the nudge', async () => {
    const c = setup();
    c.tasks.create({ missionId: c.mission.id, title: 'Independent work' });
    await c.scan(0);
    h.judge.mockImplementationOnce(async () => {
      recordOperatorTabCompletionRequest(c.suite.scope, c.mission);
      return { kind: 'skipped' };
    });
    await c.scan(30_000);
    clearCompletionRequest(c.suite.scope, c.mission.id);
    expect(c.notices()).toHaveLength(0);
    expect(h.delivered).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
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
    expect(h.event).not.toHaveBeenCalled();
  });

  // Bug7 (B), justificativa do escopo: registrar cada pedido de chat como
  // suite.task foi rejeitado por invasivo — `tasks.list(mission).length`
  // alimenta sealedCount/taskCount (intent state, recovery stage, quadro de
  // entregas) e o backlog selado filtra tasks avulsas de qualquer jeito.
  // Em vez disso, só a missão livre/adotada (freeAgentChoice, sem plano
  // selado) com ZERO workers volta ao empurrão solo de 20 min do F-714;
  // missão não-livre sem trabalho registrado continua em silêncio, e com
  // worker (mesmo idle) o teste seguinte segue valendo sem alteração.
  it('Bug7: adopted free mission, no registered tasks, zero workers: solo nudge after 20 min', async () => {
    const c = setup();
    h.panes = h.panes.slice(0, 1);
    await c.scan(0);
    await c.scan(19 * 60_000);
    expect(c.notices()).toHaveLength(0);
    await c.scan(20 * 60_000);
    expect(c.notices()).toHaveLength(1);
    expect(c.notices()[0].summary).toContain('Esteira parada');
    expect(c.notices()[0].summary).toContain('20 min');
    expect(h.event).toHaveBeenCalledWith(c.suite.scope, {
      missionId: c.mission.id,
      runId: 'delegation-supervisor',
      type: 'custom',
      origin: 'main',
      idempotencyKey: `momentum-stalled:${c.notices()[0].id}`,
      payload: { kind: 'momentum-stalled', idleMinutes: 20 },
    });
    expect(c.notices()[0].summary).not.toContain('tarefas registradas prontas');
    await c.scan(21 * 60_000);
    expect(c.notices()).toHaveLength(1);
  });

  it('Bug7: non-free mission without registered work stays quiet even solo for an hour', async () => {
    const c = setup({ free: false });
    h.panes = h.panes.slice(0, 1);
    await c.scan(0);
    await c.scan(3600000);
    expect(c.notices()).toHaveLength(0);
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

  // O Maestro perguntou e parou: empurrá-lo de novo a cada hora é ruído no
  // turno dele. A espera termina quando o operador responde (aqui: "agora
  // não"), e o nudge volta ao normal.
  it('a pending clarify silences the solo nudge until the operator answers', async () => {
    const c = setup();
    h.panes = h.panes.slice(0, 1);
    const question = askOperator(c);
    await c.scan(0);
    await c.scan(20 * 60_000);
    await c.scan(60 * 60_000);
    expect(c.notices()).toHaveLength(0);
    expect(h.delivered).not.toHaveBeenCalled();
    c.handoffs.submit({
      missionId: c.mission.id,
      fromAgent: 'Operador Nexus',
      status: 'progress',
      summary: 'Operador adiou a pergunta "Qual caminho?" (agora não).',
      artifacts: [
        {
          kind: 'nexus-clarify-dismiss',
          schemaVersion: 1,
          questionId: question.id,
        },
      ],
    });
    await c.scan(61 * 60_000);
    expect(c.notices()).toHaveLength(1);
    expect(c.notices()[0].summary).toContain('Esteira parada');
    expect(h.delivered).toHaveBeenCalledTimes(1);
  });

  it('an awaiting-input latch on the Maestro silences the nudge; released, it returns', async () => {
    const c = setup();
    h.panes = h.panes.slice(0, 1);
    h.awaitingOperator.mockImplementation(
      (sessionId) => sessionId === 'leader-session',
    );
    await c.scan(0);
    await c.scan(20 * 60_000);
    expect(c.notices()).toHaveLength(0);
    h.awaitingOperator.mockReturnValue(false);
    await c.scan(21 * 60_000);
    expect(c.notices()).toHaveLength(1);
    expect(c.notices()[0].summary).toContain('Esteira parada');
  });

  // Teto longo: no máximo UM lembrete, ao OPERADOR (jornal de eventos — nunca
  // um handoff pasteado no PTY do Maestro).
  it('six hours of operator wait: one operator reminder, never a Maestro nudge', async () => {
    const c = setup();
    h.panes = h.panes.slice(0, 1);
    askOperator(c);
    await c.scan(0);
    await c.scan(MOMENTUM_OPERATOR_WAIT_CEILING_MS - 60_000);
    expect(reminderEvents(c)).toHaveLength(0);
    expect(c.notices()).toHaveLength(0);
    await c.scan(MOMENTUM_OPERATOR_WAIT_CEILING_MS);
    expect(reminderEvents(c)).toHaveLength(1);
    expect(c.notices()).toHaveLength(0);
    expect(h.delivered).not.toHaveBeenCalled();
    await c.scan(MOMENTUM_OPERATOR_WAIT_CEILING_MS + 60 * 60_000);
    await c.scan(MOMENTUM_OPERATOR_WAIT_CEILING_MS * 2);
    expect(reminderEvents(c)).toHaveLength(1);
  });

  it('a new operator wait after the answer starts a fresh episode and can remind again', async () => {
    const c = setup();
    h.panes = h.panes.slice(0, 1);
    const question = askOperator(c);
    await c.scan(0);
    await c.scan(MOMENTUM_OPERATOR_WAIT_CEILING_MS);
    expect(reminderEvents(c)).toHaveLength(1);
    expect(c.notices()).toHaveLength(0);
    c.handoffs.submit({
      missionId: c.mission.id,
      fromAgent: 'Operador Nexus',
      status: 'progress',
      summary: 'Resposta humana à pergunta "Qual caminho?": Sim.',
      artifacts: [
        {
          kind: 'nexus-clarify-answer',
          schemaVersion: 1,
          questionId: question.id,
          answer: { kind: 'chip', chipId: 'opt-1', value: 'Sim' },
        },
      ],
    });
    const afterAnswer = MOMENTUM_OPERATOR_WAIT_CEILING_MS + 60_000;
    await c.scan(afterAnswer);
    expect(c.notices()).toHaveLength(1);
    expect(reminderEvents(c)).toHaveLength(1);
    askOperator(c);
    const secondWaitStart = afterAnswer + 60_000;
    await c.scan(secondWaitStart);
    await c.scan(secondWaitStart + MOMENTUM_OPERATOR_WAIT_CEILING_MS);
    expect(reminderEvents(c)).toHaveLength(2);
  });
});
