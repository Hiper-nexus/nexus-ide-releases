import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorkingTreeCandidateSnapshot } from '../context/candidate-working-tree-snapshot';
import { testProjectScope } from './__tests__/scope-fixture';
import { assertMcpInvocationCurrent, type McpToolInvocation } from './mcp-protocol';
import { armedAutoClosePaneId, disarmAutoCloseOnHandoff, scheduleAutoCloseAfterHandoff } from './pane-close-scopes';
import { admitAgentSpawnSync, primeSystemMemoryCacheForTest } from './pane-admission';

const state = vi.hoisted(() => ({
  mission: undefined as Mission | undefined, scope: undefined as ProjectExecutionScope | undefined,
  executionScope: undefined as ProjectExecutionScope | undefined, candidate: undefined as WorkingTreeCandidateSnapshot | undefined,
  baseSha: null as string | null, route: null as Record<string, unknown> | null,
  live: new Map<string, Record<string, unknown>>(), events: [] as Record<string, unknown>[],
  dirty: true, recordFails: false, closeAccepts: true, sequence: 0, leader: 'maestro', frozen: false, acp: false,
  squad: null as { agents: Array<Record<string, unknown>> } | null,
  capture: vi.fn(), checks: vi.fn(), spawn: vi.fn(), close: vi.fn(), select: vi.fn(), deliver: vi.fn(), legacyRecord: vi.fn(), measure: vi.fn(),
}));
vi.mock('../context/candidate-working-tree-snapshot', () => ({ captureWorkingTreeCandidate: (...args: unknown[]) => state.capture(...args) }));
vi.mock('../pty/pty-manager', () => ({ getAgentSessionInfo: (id: string) => state.acp ? undefined : state.live.get(id), getSessionState: (id: string) => !state.acp && state.live.has(id) ? 'idle' : undefined }));
vi.mock('../acp/acp-harness-driver', () => ({ getAcpDriverSession: (id: string) => state.acp && state.live.has(id) ? { agent: state.live.get(id) } : null }));
vi.mock('./gate', () => ({ getContextBySession: () => ({ sessionId: 'maestro', missionId: state.mission!.id, scope: state.scope, role: 'orchestrator' }), isCurrentGateContext: () => true,
  executionScopeFor: (ctx: { executionScope?: ProjectExecutionScope; scope: ProjectExecutionScope }) => ctx.executionScope ?? ctx.scope }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: () => ({ missions: {
  get: (id: string) => state.mission?.id === id ? state.mission : null,
  codeBaseline: { read: () => state.baseSha ? { status: 'known', headSha: state.baseSha } : { status: 'unknown' } },
  reviewVerdicts: { record: (...args: unknown[]) => state.legacyRecord(...args) },
}, missionPanes: { record: () => { if (state.recordFails) throw new Error('store unavailable'); } } }) }));
vi.mock('./mission-execution-scope', () => ({ missionExecutionScope: () => state.executionScope, missionExecutionBaseSha: () => undefined }));
vi.mock('./mission-leader-gate', () => ({ requireMissionLeaderSession: () => ({ ok: true, leader: { sessionId: state.leader } }) }));
vi.mock('./mission-review-proof', () => ({ readFrozenMissionReviewContext: () => state.frozen ? {} : null }));
vi.mock('./pane-registry', () => ({ listPaneSnapshots: () => [], requestPaneSpawn: (...args: unknown[]) => state.spawn(...args), requestMissionPaneClose: (...args: unknown[]) => state.close(...args) }));
vi.mock('./tools-panes', () => ({ suggestOperatorRoute: (...args: unknown[]) => state.select(...args) }));
vi.mock('./task-router', () => ({ isFrontierReviewer: (_id: string, model: string) => ['gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5'].includes(model) }));
vi.mock('./operator-spawn-route', () => ({ adapterIdsWithoutNexusMcp: () => ['no-mcp'] }));
vi.mock('../adapters/adapter-registry', () => ({ listAdapters: () => [{ id: 'codex' }, { id: 'claude' }, { id: 'no-mcp' }] }));
vi.mock('./cli-mcp-inject', () => ({ canUseNexusMcp: () => true }));
vi.mock('./squad-store', () => ({ getSquad: () => state.squad }));
vi.mock('./mission-event-journal', () => ({ MissionEventJournal: class { append(event: Record<string, unknown>) { state.events.push(event); return { id: `event-${state.events.length}` }; } } }));
vi.mock('./mission-event-emit', () => ({ getMissionEventRuntimeManager: () => ({}) }));
vi.mock('./civilian-auto-review', () => ({ enforceCivilianAutoReview: (...args: unknown[]) => state.checks(...args) }));
vi.mock('./tool-util', () => ({ deliverAgentPrompt: (...args: unknown[]) => state.deliver(...args) }));
vi.mock('./integration-review-gate', () => ({ measureIntegrationStateAsync: (...args: unknown[]) => state.measure(...args) }));

import { runMissionCodeCompletion, recordMissionCodeCompletionReview, forgetMissionCodeCompletion, isCurrentCodeCompletionFindingFix } from './mission-code-completion-production';

beforeEach(async () => {
  if (state.scope && state.mission) await forgetMissionCodeCompletion(state.scope, state.mission.id);
  vi.clearAllMocks();
  state.scope = testProjectScope(); state.executionScope = state.scope;
  state.mission = { id: `mission-${++state.sequence}`, title: 'Corrigir o produto', description: '', status: 'running', updatedAt: 1, intentVersion: 1,
    intentContract: { lane: 'standard', freeAgentChoice: true, goal: 'Corrigir o produto' }, orchestratorSessionId: 'maestro' } as Mission;
  state.baseSha = 'a'.repeat(40);
  state.candidate = { source: 'git', headSha: 'b'.repeat(40), fingerprint: 'candidate', changedPaths: ['src/app.ts'], deletedPaths: [], untrackedPaths: [], diff: '', complete: true, incompleteReasons: [] };
  state.route = { adapterId: 'codex', model: 'gpt-6.1-sol' }; state.dirty = true;
  state.recordFails = false; state.closeAccepts = true; state.live.clear(); state.events.length = 0; state.squad = null; state.leader = 'maestro'; state.frozen = false; state.acp = false;
  state.capture.mockImplementation(async () => ({ ...state.candidate! }));
  state.measure.mockImplementation(async () => ({ headSha: state.candidate!.headSha, treeDirty: state.dirty }));
  state.select.mockImplementation(async () => state.route);
  state.deliver.mockResolvedValue(true);
  state.spawn.mockImplementation(async (options: Record<string, unknown>) => {
    const sessionId = `judge-${++state.sequence}`;
    state.live.set(sessionId, { scope: state.acp ? state.scope : state.executionScope, model: options.model, readOnly: true });
    return { ok: true, paneId: sessionId, sessionId };
  });
  state.close.mockImplementation(async (options: { sessionId: string }) => { if (!state.closeAccepts) return false; state.live.delete(options.sessionId); return true; });
  state.checks.mockImplementation(async () => ({ kind: 'approved', evidenceId: 'checks:current', note: 'Checks atuais', verification: {
    analysisComplete: true, headSha: state.candidate!.headSha, baseSha: state.baseSha,
    checks: [{ kind: 'typecheck', status: 'passed', summary: 'Compiler passed' }],
    regression: { status: 'no-tests', testsRun: [], testsNotRun: [] }, regressionApplicable: false,
  } }));
  state.legacyRecord.mockImplementation(input => ({ ...input, verdictId: 'legacy-review' }));
});
afterEach(async () => { vi.useRealTimers(); for (const id of state.live.keys()) disarmAutoCloseOnHandoff(id, id);
  if (state.scope && state.mission) await forgetMissionCodeCompletion(state.scope, state.mission.id); primeSystemMemoryCacheForTest(null); });
const run = () => runMissionCodeCompletion({ scope: state.scope!, mission: state.mission!, productFiles: state.candidate!.changedPaths, liveOrchestratorSessionId: 'maestro' });
const record = (verdict: 'approve' | 'reject' = 'approve') => recordMissionCodeCompletionReview({ scope: state.scope!, executionScope: state.executionScope!, missionId: state.mission!.id,
  sessionId: [...state.live.keys()][0], providerId: state.route!.adapterId, role: 'worker', readOnly: true } as never,
{ verdict, summary: 'Current review', findings: verdict === 'reject' ? ['F-42 src/app.ts:7 condição errada'] : [] });

describe('Main code completion production ports', () => {
  it('routes a frontier read-only reviewer in the correct execution scope and persists Main evidence', async () => {
    expect((await run()).kind).toBe('waiting');
    expect(state.select).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ requireReadOnlyEnforceable: true, excludeAdapterIds: ['no-mcp'] }));
    expect(state.spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker', readOnly: true, executionScope: state.executionScope }));
    expect((await record()).accepted).toBe(true);
    expect(state.events[0]).toMatchObject({ origin: 'main', payload: { schema: 'nexus.code-review/v1', fingerprint: 'candidate' } });
    expect((await run()).kind).toBe('verified');
    expect(state.legacyRecord).not.toHaveBeenCalled(); // Dirty review never approves Git push.
  });

  it('recognizes an ACP reviewer as live, accepts its Main-bound verdict and physically closes it on forget', async () => {
    state.acp = true;
    state.executionScope = { ...state.scope!, rootRealPath: '/tab-execution' };
    await run(); await run(); expect(state.spawn).toHaveBeenCalledOnce();
    expect((await record()).accepted).toBe(true);
    expect(state.measure).toHaveBeenCalledWith('/tab-execution');
    expect((await run()).kind).toBe('verified');
    await forgetMissionCodeCompletion(state.scope!, state.mission!.id);
    expect(state.close).toHaveBeenCalledOnce(); expect(state.live.size).toBe(0);
  });

  it('dispatches a rejected candidate for repair once and keeps the mission waiting without a human lock', async () => {
    await run(); await record('reject');
    expect((await run()).kind).toBe('waiting');
    await Promise.resolve(); await Promise.resolve();
    expect(state.deliver).toHaveBeenCalledOnce();
    expect(state.deliver.mock.calls[0][1]).toContain('F-42');
    expect((await run()).kind).toBe('waiting');
    expect(state.deliver).toHaveBeenCalledOnce();
  });

  it('a four-pane budget frees the rejected reviewer only after its persisted handoff and physical exit, allowing repair', async () => {
    let physicalAgents = 3;
    primeSystemMemoryCacheForTest({ freeMB: 64_000, swapUsedMB: 0 });
    const admission = () => admitAgentSpawnSync(physicalAgents, Date.now(), { NEXUS_PANE_CAP: '4' }, { automaticWorker: true });
    const spawn = state.spawn.getMockImplementation()!;
    state.spawn.mockImplementation(async (...args: unknown[]) => { expect(admission().ok).toBe(true); physicalAgents += 1; return spawn(...args); });
    await run(); await record('reject');
    const reviewerId = [...state.live.keys()][0]!;
    expect(armedAutoClosePaneId(reviewerId)).toBe(reviewerId);
    expect(admission().ok).toBe(false);
    let exited!: () => void; const physicalExit = new Promise<void>(resolve => { exited = resolve; });
    state.close.mockImplementation(async () => { await physicalExit; state.live.delete(reviewerId); physicalAgents -= 1; return true; });
    scheduleAutoCloseAfterHandoff(reviewerId, 'success', id => state.live.has(id) ? id : null,
      (paneId, sessionId) => state.close({ paneId, sessionId }));
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
    expect(admission().ok).toBe(false);
    exited(); await vi.waitFor(() => expect(physicalAgents).toBe(3));
    expect(admission().ok).toBe(true);
    expect((await run()).kind).toBe('waiting');
    expect(state.spawn).toHaveBeenCalledOnce(); // The persisted rejection survives reviewer exit.
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija F-42')).toBe(true);
  });

  it('revalidates the leader through the real invocation hook after a deferred repair delivery', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let pasted = false; let settled = false;
    state.deliver.mockImplementation(async (_id, _prompt, invocation: McpToolInvocation) => {
      try { await blocked; assertMcpInvocationCurrent(invocation); pasted = true; return true; }
      finally { settled = true; }
    });
    await run(); await record('reject'); await run();
    await vi.waitFor(() => expect(state.deliver).toHaveBeenCalledOnce());
    state.leader = 'new-maestro'; release();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(pasted).toBe(false);
  });

  it('bounds repair transport retries without a human lock and recovers when delivery becomes available', async () => {
    vi.useFakeTimers(); state.deliver.mockResolvedValue(false);
    await run(); await record('reject'); await run(); await vi.advanceTimersByTimeAsync(0);
    expect(state.deliver).toHaveBeenCalledTimes(1);
    await run(); expect(state.deliver).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await vi.advanceTimersByTimeAsync(31_000); expect((await run()).kind).toBe('waiting');
      await vi.advanceTimersByTimeAsync(0); expect(state.deliver).toHaveBeenCalledTimes(attempt);
    }
    await vi.advanceTimersByTimeAsync(31_000); await run(); expect(state.deliver).toHaveBeenCalledTimes(3);
    state.deliver.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000); await run(); await vi.advanceTimersByTimeAsync(0);
    expect(state.deliver).toHaveBeenCalledTimes(4);
    expect((await run()).kind).toBe('waiting'); expect(state.deliver).toHaveBeenCalledTimes(4);
  });

  it('retries temporary spawn capacity/auth failure after the interval without duplicate physical spawns', async () => {
    vi.useFakeTimers(); state.spawn.mockResolvedValueOnce({ ok: false, error: 'capacity' });
    expect((await run()).kind).toBe('waiting'); await run(); expect(state.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000); expect((await run()).kind).toBe('waiting');
    expect(state.spawn).toHaveBeenCalledTimes(2); expect(state.live.size).toBe(1);
  });

  it('cache hits never renew the original five-minute expiry', async () => {
    vi.useFakeTimers();
    await run(); expect(state.checks).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4 * 60_000); await run();
    expect(state.checks).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(61_000); await run();
    expect(state.checks).toHaveBeenCalledTimes(2);
  });

  it.each(['goal', 'root', 'base'])('does not reuse mechanical evidence after a %s change with the same fingerprint', async change => {
    await run();
    if (change === 'goal') state.mission = { ...state.mission!, title: 'Outro objetivo' };
    if (change === 'root') state.executionScope = { ...state.executionScope!, rootRealPath: '/another-execution-root' };
    if (change === 'base') state.baseSha = 'c'.repeat(40);
    await run(); expect(state.checks).toHaveBeenCalledTimes(2);
  });

  it('binds current finding correction to exact references, fingerprint, scope and a Main rejection even for dirty/non-Git work', async () => {
    state.baseSha = null; state.candidate = { ...state.candidate!, source: 'filesystem', headSha: null };
    await run(); await record('reject');
    expect(state.events[0]).toMatchObject({ payload: { verdict: { headSha: null } } });
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija F-42')).toBe(true);
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija F-420')).toBe(false);
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija src/app.ts:70')).toBe(false);
    state.candidate = { ...state.candidate!, fingerprint: 'changed' };
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija F-42')).toBe(false);
    expect(state.legacyRecord).not.toHaveBeenCalled();
  });

  it('does not leave a spawned pane alive when its durable binding cannot be recorded', async () => {
    state.recordFails = true; expect((await run()).kind).toBe('waiting');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalled());
    expect(state.live.size).toBe(0);
  });

  it('closes a pane returned after a cancelled Main spawn and never publishes its verdict', async () => {
    const original = state.spawn.getMockImplementation()!;
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    state.spawn.mockImplementation(async (...args: unknown[]) => { await blocked; return original(...args); });
    const controller = new AbortController();
    const pending = runMissionCodeCompletion({ scope: state.scope!, mission: state.mission!, productFiles: ['src/app.ts'],
      lifetime: { signal: controller.signal, assertCurrent: () => { if (controller.signal.aborted) throw new Error('cancelled'); } } as never }).catch(error => error);
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
    controller.abort(); release(); await pending;
    await vi.waitFor(() => expect(state.live.size).toBe(0));
    expect(state.events).toHaveLength(0);
  });

  it('uses a real guided squad reviewer instead of inventing a roster member', async () => {
    state.mission = { ...state.mission!, squadId: 'guided', intentContract: { ...state.mission!.intentContract!, freeAgentChoice: false } };
    state.squad = { agents: [{ id: 'actual-reviewer', agentName: 'QA Oficial', category: 'reviewer', cli: 'claude', model: 'claude-opus-5-5', allowedTools: null }] };
    state.route = { adapterId: 'claude', model: 'claude-opus-5-5' };
    await run();
    expect(state.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'QA Oficial', adapterId: 'claude', model: 'claude-opus-5-5' }));
  });

  it('preserves a frontier guided reviewer with an arbitrary name when two roster members share its CLI', async () => {
    state.mission = { ...state.mission!, squadId: 'guided', intentContract: { ...state.mission!.intentContract!, freeAgentChoice: false } };
    state.squad = { agents: [
      { id: 'writer', agentName: 'Builder', category: 'executor', cli: 'claude', model: 'cheap' },
      { id: 'judge', agentName: 'Ana', category: 'reviewer', cli: 'claude', model: 'claude-opus-5-5' },
    ] };
    state.select.mockImplementation(async (task: string) => ({ adapterId: 'claude', model: task.includes('Revisão independente') && task.includes('claude-opus-5-5') ? 'claude-opus-5-5' : 'cheap' }));
    await run(); expect(state.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Ana', model: 'claude-opus-5-5' }));
  });

  it('does not create an out-of-plan reviewer when a frozen Council already owns the workflow, including free choice', async () => {
    state.frozen = true;
    expect((await run()).kind).toBe('waiting');
    expect(state.select).not.toHaveBeenCalled(); expect(state.spawn).not.toHaveBeenCalled(); expect(state.checks).not.toHaveBeenCalled();
  });

  it('keeps the Main visual goal in routing so existing UI preferences can apply', async () => {
    state.mission = { ...state.mission!, intentContract: { ...state.mission!.intentContract!, goal: 'Redesenhe a UI da landing com a preferência visual configurada' } };
    await run(); expect(state.select.mock.calls[0][0]).toContain('Redesenhe a UI');
  });

  it('records legacy push approval only for the exact reviewed clean Git candidate', async () => {
    state.dirty = false; await run(); await record();
    expect((await run()).kind).toBe('verified');
    expect(state.legacyRecord).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'b'.repeat(40), treeDirty: false, verdict: 'approve', frontier: true }));
    expect(state.legacyRecord.mock.calls[0][0]).not.toHaveProperty('verdictId');
    expect(state.legacyRecord.mock.calls[0][0]).not.toHaveProperty('createdAt');
  });

  it('never retags a reviewed approval onto a new HEAD observed during the legacy push check', async () => {
    state.dirty = false; await run(); await record();
    state.measure.mockImplementation(async () => {
      state.candidate = { ...state.candidate!, headSha: 'c'.repeat(40), fingerprint: 'changed-during-legacy-check' };
      return { headSha: state.candidate.headSha, treeDirty: false };
    });
    expect((await run()).kind).toBe('waiting');
    expect(state.legacyRecord).not.toHaveBeenCalled();
  });

  it('uses the same covered artifact set for routing, mechanics and every later reviewer recapture', async () => {
    state.candidate = { ...state.candidate!, changedPaths: [], coveredPaths: ['src/app.ts'] };
    const input = { scope: state.scope!, mission: state.mission!, productFiles: ['src/app.ts'] };
    await runMissionCodeCompletion(input);
    expect(state.capture.mock.calls[0][0]).toMatchObject({ requiredPaths: ['src/app.ts'] });
    expect(state.checks.mock.calls[0][0]).toMatchObject({ productFiles: ['src/app.ts'] });
    expect(state.spawn.mock.calls[0][0].initialPrompt).toContain('src/app.ts');
    await record('reject');
    expect(await isCurrentCodeCompletionFindingFix(state.scope!, state.mission!.id, 'Corrija F-42')).toBe(true);
    expect(state.capture.mock.calls.every(([options]) => options.requiredPaths?.includes('src/app.ts'))).toBe(true);
  });
});
