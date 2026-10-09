import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { bindTokenToSession, isCurrentGateContext, mintToken, resetGateForTests } from './gate';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry, getProjectDomainStores } from './project-domain-store-registry';
import { getMissionLeadership } from './mission-leadership-runtime';
import { missionEngineForScope } from './mission-engine-registry';
import { configureMissionEventEmit } from './mission-event-emit';
import './mission-engine-production';
import { buildDomainTools } from './tools-domain';
import { validateToolArgs } from './mcp-args-validation';
import { persistClarifyAnswer, prepareClarifyAnswerAuthorityCandidate, resetForwardedNativeClarifyForTests } from './clarify-flow';
import { startRuntimeGateway } from '../../../scripts/runtime-gateway.mjs';

// Only physical process/renderer observations and unrelated background memory
// are controlled. The scoped SQLite stores, leader/gate, tools and engine ports
// below are production implementations; no CLI or credential is opened.
const physical = vi.hoisted(() => ({ session: null as OwnedAgentSessionInfo | null }));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }));
vi.mock('../memory/workspace-memory-service', () => ({ startWorkspaceMemoryService: () => ({ stop: async () => {} }) }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => physical.session?.sessionId === id ? physical.session : null,
  getRuntimeAgentSessionInfo: (id: string) => physical.session?.sessionId === id ? physical.session : null,
  getSessionState: (id: string) => physical.session?.sessionId === id ? 'idle' : null,
  listAgentSessions: () => physical.session ? [physical.session] : [],
  listAgentSessionsForPane: (id: string) => physical.session?.paneId === id ? [physical.session] : [],
  registeredOrchestratorSessionsForMission: (id: string) => physical.session?.missionId === id ? [{ sessionId: physical.session.sessionId, state: 'idle', adapterId: 'claude' }] : [],
  orchWriteSession: () => false,
  spawnAgentSession: () => { throw new Error('physical spawn forbidden in source regression'); },
}));
vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => physical.session ? [{ ...physical.session, kind: 'cli-agent' }] : [],
  getPaneRuntimeAuthorityBySession: () => null,
  readSessionOutput: () => '',
}));

it('F-1106: real clarify→status reaches canonical question, preserves retry, and only a durable answer resumes', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-runtime-question-'));
  const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'F1106-test' });
  const scope = testProjectScope({ checkoutId: 'runtime-question', rootRealPath: baseDir });
  const nonce = '11111111-1111-4111-8111-111111111111';
  const gateway = await startRuntimeGateway(nonce);
  try {
    configureProjectDomainStoreRegistry(manager);
    configureMissionEventEmit(manager);
    const stores = getProjectDomainStores(scope);
    const tools = buildDomainTools();
    const statusTool = tools.find(t => t.name === 'nexus_mission_set_status')!;
    const mission = stores.missions.create({ title: 'Runtime QUESTION fixture', intentState: 'executing', intentVersion: 1,
      orchestratorSessionId: 'runtime-chief', intentContract: {
        ...compileIntentContract({ goal: 'Runtime QUESTION fixture', intentVersion: 1 }),
        approvedAt: Date.now(), dispatchedAt: Date.now(), lane: 'ops',
      } });
    const ctx = mintToken({ label: 'Runtime chief', role: 'orchestrator', missionId: mission.id, scope,
      allowedTools: ['nexus_clarify', 'nexus_mission_set_status'], allowedSkills: [] });
    bindTokenToSession(ctx.token, 'runtime-chief');
    physical.session = { sessionId: 'runtime-chief', paneId: 'runtime-chief-pane', adapterId: 'claude', role: 'orchestrator',
      missionId: mission.id, scope, cwd: baseDir, source: 'persisted-pane', readOnly: false,
      allowedTools: ctx.allowedTools, allowedSkills: [] };
    const invocation = { assertCurrentAuthority: () => { if (!isCurrentGateContext(ctx)) throw new Error('source authority revoked'); } };
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: `RT_GATE QUESTION ${nonce}` }];
    async function next() {
      const response = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
        body: JSON.stringify({ tools: tools.map(t => ({ name: t.name, input_schema: t.inputSchema })), messages }) });
      expect(response.status).toBe(200);
      const text = await response.text();
      const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const call = events.find(event => event.type === 'content_block_start').content_block;
      if (call.type === 'tool_use') call.input = JSON.parse(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json);
      return { call, text };
    }
    async function execute(call: { id: string; name: string; input: Record<string, unknown> }) {
      validateToolArgs(call.name, call.input);
      const tool = tools.find(candidate => candidate.name === call.name)!;
      const result = await tool.handler(call.input, ctx, invocation);
      messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [
        { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: JSON.stringify(result) }] },
      ] });
      return result;
    }
    await statusTool.handler({ missionId: mission.id, status: 'running' }, ctx, invocation);
    getMissionLeadership().applyLeadership(scope, mission.id, { sessionId: 'runtime-chief', paneId: 'runtime-chief-pane', origin: 'spawn' });
    const engine = missionEngineForScope(scope);
    const first = await next();
    expect(first.call.name).toBe('nexus_clarify');
    const registered = await execute(first.call) as { questionId: string };
    expect(stores.handoffs.get(registered.questionId)).toMatchObject({ missionId: mission.id, deliveryState: 'submitted' });
    expect(stores.missions.get(mission.id)).toMatchObject({ status: 'running', intentState: 'executing' });
    expect((await engine.snapshot(scope, mission.id)).question).toBeUndefined();
    const second = await next();
    expect(second.call.name).toBe('nexus_mission_set_status');
    expect(await execute(second.call)).toMatchObject({ id: mission.id, status: 'blocked', intentState: 'blocked_user' });
    const questioned = await engine.snapshot(scope, mission.id);
    expect(questioned.state).toBe('blocked_user');
    expect(questioned.question).toEqual({ id: registered.questionId, prompt: `RT_QUESTION_${nonce}: select the private fixture route.`,
      options: [{ id: 'opt-1', label: 'Proceed' }, { id: 'opt-2', label: 'Wait' }], allowFreeText: false });
    const done = await next(); expect(done.text).toContain(`RT_DONE_QUESTION_${nonce}`);
    await expect(engine.command(scope, { kind: 'retry-kickoff', missionId: mission.id })).rejects.toThrow(/answer-question/);
    expect((await engine.snapshot(scope, mission.id)).question).toEqual(questioned.question);
    const answerInput = { missionId: mission.id, questionId: registered.questionId, answer: 'opt-1' };
    const candidate = prepareClarifyAnswerAuthorityCandidate(stores, scope, answerInput);
    const answer = await persistClarifyAnswer(stores, scope, answerInput, candidate.fence, () => {}, engine);
    expect(answer.ok).toBe(true);
    expect(stores.handoffs.get(registered.questionId)?.deliveryState).toBe('consumed');
    expect(stores.missions.get(mission.id)).toMatchObject({ status: 'running', intentState: 'executing' });
    expect((await engine.snapshot(scope, mission.id)).question).toBeUndefined();
  } finally {
    await gateway.close();
    physical.session = null; resetGateForTests(); resetForwardedNativeClarifyForTests();
    configureMissionEventEmit(null); await disposeProjectDomainStoreRegistry(); manager.closeAll();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
