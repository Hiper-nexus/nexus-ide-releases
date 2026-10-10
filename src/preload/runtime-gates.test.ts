// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installRuntimeGatePreload } from './runtime-gates';
import { RUNTIME_CHANNELS, RUNTIME_DOM_REQUEST, RUNTIME_DOM_REPLY } from '../shared/runtime-gates';
import { isToolAllowedForRole } from '../main/orch/gate';
it('the private frozen chief can register a question and declare its normal blocked status', async () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: (channel: string, value: unknown) => ipc.emit(channel, value) });
  let statusAllowed = false, previewAllowed = false;
  const api = { mission: { prepare: async (review: { roster: { category: string; allowedTools: string[] }[] }) => {
    const chief = review.roster.find(agent => agent.category === 'orchestrator')!;
    statusAllowed = isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_mission_set_status');
    expect(isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_clarify')).toBe(true);
    const writer = review.roster.find(agent => agent.category === 'executor')!;
    previewAllowed = isToolAllowedForRole('worker', writer.allowedTools, 'nexus_preview_start');
    expect(isToolAllowedForRole('orchestrator', chief.allowedTools, 'nexus_catalog_install')).toBe(false);
    throw new Error('private test preparation ended');
  } } };
  const ended = new Promise<void>(resolve => ipc.once(RUNTIME_CHANNELS.result, () => resolve()));
  installRuntimeGatePreload(ipc as never, api as never, { isMainFrame: true });
  ipc.emit(RUNTIME_CHANNELS.run, null, { nonce: '11111111-1111-4111-8111-111111111111', gatewayNonce: '22222222-2222-4222-8222-222222222222', phase: 'exercise', workspacePath: '/private/runtime-fixture' });
  await ended;
  expect(statusAllowed).toBe(true);
  expect(previewAllowed).toBe(true);
});
it('does not execute product APIs for incomplete/foreign private instructions', () => {
  const api = { mission: { prepare: vi.fn() } }, ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn() });
  installRuntimeGatePreload(ipc as never, api as never, { isMainFrame: true });
  for (const raw of [null, {}, { nonce: 'old', phase: 'exercise', workspacePath: '/private' },
    { nonce: '11111111-1111-4111-8111-111111111111', phase: 'unknown', workspacePath: '/private' }]) ipc.emit(RUNTIME_CHANNELS.run, null, raw);
  expect(api.mission.prepare).not.toHaveBeenCalled(); expect(ipc.invoke).not.toHaveBeenCalled(); expect(ipc.send).not.toHaveBeenCalled();
});
it('does not install the private driver in a subframe', () => {
  const ipc = { on: vi.fn() }; installRuntimeGatePreload(ipc as never, {} as never, { isMainFrame: false }); expect(ipc.on).not.toHaveBeenCalled();
});
it.each(['identity', 'report-ready', 'missing-reviewer', 'ambiguous-reviewer'])('F-1112: selects named workers and preserves report causality (%s)', async stage => {
  if (stage === 'missing-reviewer') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const marker = '22222222-2222-4222-8222-222222222222';
  let question = false, opsStopped = false, prepared = 0, resumed = false, writeDirected = false, reportReady = false;
  const directions: Array<{ targetAgentId: string; text: string }> = [];
  const writer = { role: 'worker', agentName: 'Runtime writer', paneId: 'writer-pane', sessionId: 'writer-sid', adapterId: 'claude', pid: 200, conversation: { key: 'session_id', id: 'writer-native' } };
  const reviewer = { ...writer, agentName: 'Runtime reviewer', paneId: 'reviewer-pane', sessionId: 'reviewer-sid', pid: 201 };
  const newWriter = { ...writer, paneId: 'returned-writer', sessionId: 'new-writer-sid', pid: 202 };
  const chief = { ...writer, role: 'orchestrator', agentName: 'Runtime chief', paneId: 'chief-pane', sessionId: 'chief-sid', pid: 199 };
  const ipc = Object.assign(new EventEmitter(), { invoke: async (_channel: string, request: { operation: string; missionId: string }) => {
    if (writeDirected && request.operation === 'observe') reportReady = true;
    return request.operation !== 'observe' ? {} :
    request.missionId === 'ops' ? { agents: opsStopped ? [] : [chief], audit: [{ tool: 'nexus_terminal_run', result: 'ok' }],
      snapshot: { question: question ? { id: 'question', options: [{ id: 'proceed' }] } : undefined } } :
    { agents: [...(stage === 'missing-reviewer' ? [] : stage === 'ambiguous-reviewer' && reportReady ? [reviewer, { ...reviewer, paneId: 'other-reviewer', sessionId: 'other-reviewer-sid' }] : [reviewer]), resumed ? newWriter : writer, chief], handoffs: reportReady ? [{ sessionId: newWriter.sessionId, status: 'success', summary: `RT_WRITE_${marker}` }] : [],
      recovery: resumed ? { fromPaneId: writer.paneId, fromSessionId: writer.sessionId, paneId: newWriter.paneId, sessionId: newWriter.sessionId } : undefined,
      snapshot: { agents: [{ id: 'reviewer-id', paneId: reviewer.paneId }, { id: 'writer-id', paneId: resumed ? newWriter.paneId : writer.paneId }] } };
  },
    send: (channel: string, value: unknown) => ipc.emit(channel, value) });
  const api = { mission: { prepare: async () => ({ missionId: prepared++ ? 'std' : 'ops', reviewSha256: 'unit-review' }), start: async () => ({}),
    command: async (value: { kind: string; missionId: string; text?: string; targetAgentId?: string }) => {
      if (value.kind === 'answer-question') question = false;
      if (value.kind === 'stop') opsStopped = true;
      if (value.text?.includes('RT_GATE QUESTION')) question = true;
      if (value.text?.includes('RT_GATE IDLE')) { directions.push({ targetAgentId: value.targetAgentId!, text: value.text }); if (stage === 'identity') throw new Error('private name-selection test ended'); }
      if (value.text?.includes('RT_GATE RECOVER')) resumed = true;
      if (value.text?.includes('RT_GATE WRITE')) writeDirected = true;
      if (value.text?.includes('RT_GATE REVIEW')) { directions.push({ targetAgentId: value.targetAgentId!, text: String(reportReady) }); throw new Error('private report-order test ended'); }
      if (value.text?.includes('RT_GATE ACK')) { directions.push({ targetAgentId: 'none', text: 'ACK sent without review' }); throw new Error('private missing-review test ended'); }
      return {};
    } } };
  const ui = (event: Event) => { const detail = (event as CustomEvent).detail; window.dispatchEvent(new CustomEvent(RUNTIME_DOM_REPLY,
    { detail: { nonce: detail.nonce, request: detail.request, ok: true, result: { visible: true } } })); };
  window.addEventListener(RUNTIME_DOM_REQUEST, ui);
  const ended = new Promise<void>(resolve => ipc.once(RUNTIME_CHANNELS.result, () => resolve()));
  try {
    installRuntimeGatePreload(ipc as never, api as never, { isMainFrame: true });
    ipc.emit(RUNTIME_CHANNELS.run, null, { nonce: '11111111-1111-4111-8111-111111111111', gatewayNonce: marker, phase: 'exercise', workspacePath: '/private/runtime-fixture' });
    if (stage === 'missing-reviewer') await vi.advanceTimersByTimeAsync(46000);
    await ended; expect(directions).toEqual(stage !== 'report-ready' ? [{ targetAgentId: 'writer-id', text: `RT_GATE IDLE ${marker}` }] :
      [{ targetAgentId: 'writer-id', text: `RT_GATE IDLE ${marker}` }, { targetAgentId: 'reviewer-id', text: 'true' }]);
  } finally { window.removeEventListener(RUNTIME_DOM_REQUEST, ui); vi.useRealTimers(); }
});
