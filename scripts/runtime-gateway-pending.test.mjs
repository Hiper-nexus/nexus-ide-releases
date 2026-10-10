import { describe, expect, it } from 'vitest';
import { startRuntimeGateway } from './runtime-gateway.mjs';

const nonce = '11111111-1111-4111-8111-111111111111';
const instruction = { role: 'user', content: `RT_GATE RECOVER ${nonce} pane-old session-old` };
const pendingReceipt = { ok: true, paneId: 'pane-new', sessionId: null, pending: true, requestId: 'orchspawn-unit-1' };
const row = { paneId: 'pane-new', sessionId: 'session-new', title: 'Runtime writer', kind: 'cli-agent',
  state: 'idle', role: 'worker', adapterId: 'claude' };
function result(call, value, change = {}) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id,
    content: [{ type: 'text', text: JSON.stringify(value) }], ...change }] };
}
async function post(server, messages, tools = ['nexus_pane_spawn', 'nexus_pane_list']) {
  const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
    body: JSON.stringify({ messages, tools: tools.map(name => ({ name: `mcp__nexus__${name}` })) }) });
  const text = await response.text();
  const events = response.ok ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
  const call = events.find(event => event.type === 'content_block_start')?.content_block;
  if (call?.type === 'tool_use') call.input = JSON.parse(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json);
  return { status: response.status, call, text };
}
async function hint(server) {
  return (await fetch(`${server.url}/runtime-recovery`, { headers: { 'x-api-key': `rt-${nonce}` } })).json();
}
async function pending(server, receipt = pendingReceipt) {
  const first = await post(server, [instruction]);
  const messages = [instruction, { role: 'assistant', content: [first.call] }, result(first.call, receipt)];
  const next = await post(server, messages);
  return { first, next, messages };
}
describe('external pending recovery protocol', () => {
  it('consumes exact pending and ready public results without inventing a hint or respawning', async () => {
    const server = await startRuntimeGateway(nonce);
    try {
      const { next, messages } = await pending(server);
      expect(next.status).toBe(200);
      expect(next.call).toMatchObject({ id: 'toolu_rt_RECOVER_1', name: 'mcp__nexus__nexus_pane_list', input: {} });
      expect((await hint(server)).recovery).toBeNull();
      const done = await post(server, [...messages, { role: 'assistant', content: [next.call] }, result(next.call, [
        { ...row, paneId: 'pane-old', sessionId: 'auto-recovery-session' }, row])]);
      expect(done.status).toBe(200);
      expect(done.call.type).toBe('text');
      expect(await hint(server)).toEqual({ nonce, pid: process.pid, recovery: {
        fromPaneId: 'pane-old', fromSessionId: 'session-old', paneId: 'pane-new', sessionId: 'session-new' } });
      expect(server.observations.filter(v => v.tool === 'nexus_pane_spawn')).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('keeps absence, unrelated panes and null sessions pending across uniquely issued reads', async () => {
    const server = await startRuntimeGateway(nonce);
    try {
      const p = await pending(server); let call = p.next.call; const messages = p.messages;
      for (const rows of [[], [{ ...row, paneId: 'foreign-pane' }], [{ ...row, sessionId: null, state: 'spawning' }]]) {
        messages.push({ role: 'assistant', content: [call] }, result(call, rows));
        const next = await post(server, messages);
        expect(next.status).toBe(200); expect(next.call.name).toBe('mcp__nexus__nexus_pane_list');
        expect((await hint(server)).recovery).toBeNull(); expect(next.call.id).not.toBe(call.id); call = next.call;
      }
      messages.push({ role: 'assistant', content: [call] }, result(call, [row]));
      expect((await post(server, messages)).status).toBe(200);
      expect((await hint(server)).recovery.sessionId).toBe('session-new');
    } finally { await server.close(); }
  });
  it.each(['spawning', 'busy', 'unknown'])('keeps a non-null %s session pending until the exact target is idle', async state => {
    const server = await startRuntimeGateway(nonce);
    try {
      const p = await pending(server);
      const messages = [...p.messages, { role: 'assistant', content: [p.next.call] }, result(p.next.call, [{ ...row, state }])];
      const waiting = await post(server, messages);
      expect(waiting.status).toBe(200);
      expect(waiting.call).toMatchObject({ type: 'tool_use', name: 'mcp__nexus__nexus_pane_list', input: {} });
      expect((await hint(server)).recovery).toBeNull();
      messages.push({ role: 'assistant', content: [waiting.call] }, result(waiting.call, [row]));
      const ready = await post(server, messages);
      expect(ready.status).toBe(200); expect(ready.call.type).toBe('text');
      expect((await hint(server)).recovery).toEqual({ fromPaneId: 'pane-old', fromSessionId: 'session-old', paneId: 'pane-new', sessionId: 'session-new' });
      expect(server.observations.filter(value => value.tool === 'nexus_pane_spawn')).toHaveLength(1);
    } finally { await server.close(); }
  });
  it.each(['exited', 'parked', 'hibernated'].flatMap(state => [[state, 'session-new'], [state, null]]))('rejects an exact %s target with session=%s', async (state, sessionId) => {
    const server = await startRuntimeGateway(nonce);
    try {
      const p = await pending(server);
      const waiting = await post(server, [...p.messages, { role: 'assistant', content: [p.next.call] }, result(p.next.call, [{ ...row, state, sessionId }])]);
      expect(waiting.status).toBe(422);
      expect(waiting.call).toBeUndefined();
      expect((await hint(server)).recovery).toBeNull();
      expect(server.observations.filter(value => value.tool === 'nexus_pane_spawn')).toHaveLength(1);
    } finally { await server.close(); }
  });
  it.each(['missing-ok', 'missing-pending', 'false-pending', 'non-null-pending', 'missing-request', 'bad-request', 'old-pane', 'bad-pane'])(
    'rejects invalid pending receipt %s', async variant => {
      const server = await startRuntimeGateway(nonce); const receipt = { ...pendingReceipt };
      if (variant === 'missing-ok') delete receipt.ok;
      if (variant === 'missing-pending') delete receipt.pending;
      if (variant === 'false-pending') receipt.pending = false;
      if (variant === 'non-null-pending') receipt.sessionId = 'session-new';
      if (variant === 'missing-request') delete receipt.requestId;
      if (variant === 'bad-request') receipt.requestId = '../invalid';
      if (variant === 'old-pane') receipt.paneId = 'pane-old';
      if (variant === 'bad-pane') receipt.paneId = '../invalid';
      try { expect((await pending(server, receipt)).next.status).toBe(422); expect((await hint(server)).recovery).toBeNull(); }
      finally { await server.close(); }
    });
  it.each(['wrapped-array', 'nested-pane', 'malformed-json', 'failed', 'error-field', 'null-row', 'duplicate-pane', 'old-session',
    'bad-session', 'wrong-role', 'wrong-adapter', 'wrong-kind', 'bad-state', 'foreign-id', 'missing-result', 'duplicate-result',
    'altered-name', 'altered-input', 'altered-id', 'reordered', 'repeated-call', 'changed-pending-receipt'])(
    'refuses unsafe pending read %s without a hint', async variant => {
      const server = await startRuntimeGateway(nonce);
      try {
        const { next, messages } = await pending(server);
        expect(next.status).toBe(200);
        let value = [row], call = structuredClone(next.call), change = {};
        if (variant === 'wrapped-array') value = { panes: [row] };
        if (variant === 'nested-pane') value = [{ holder: row }];
        if (variant === 'failed') change.is_error = true;
        if (variant === 'error-field') value = [{ ...row, error: 'fixture-error' }];
        if (variant === 'null-row') value = [null];
        if (variant === 'duplicate-pane') value = [row, { ...row, sessionId: 'another-session' }];
        if (variant === 'old-session') value = [{ ...row, sessionId: 'session-old' }];
        if (variant === 'bad-session') value = [{ ...row, sessionId: '../invalid' }];
        if (variant === 'wrong-role') value = [{ ...row, role: 'orchestrator' }];
        if (variant === 'wrong-adapter') value = [{ ...row, adapterId: 'codex' }];
        if (variant === 'wrong-kind') value = [{ ...row, kind: 'browser' }];
        if (variant === 'bad-state') value = [{ ...row, state: 'invented' }];
        if (variant === 'foreign-id') change.tool_use_id = 'foreign-call';
        if (variant === 'altered-name') call.name = 'mcp__nexus__nexus_pane_read';
        if (variant === 'altered-input') call.input = { paneId: 'pane-new' };
        if (variant === 'altered-id') call.id = 'toolu_rt_RECOVER_999';
        const callback = result(next.call, value, change);
        if (variant === 'malformed-json') callback.content[0].content[0].text = '{';
        if (variant === 'changed-pending-receipt') messages[2] = result(messages[1].content[0], { ...pendingReceipt, requestId: 'changed-attempt' });
        const pair = [{ role: 'assistant', content: [call] }, callback];
        if (variant === 'reordered') pair.reverse();
        if (variant === 'missing-result') pair.pop();
        if (variant === 'duplicate-result') pair.push(callback);
        if (variant === 'repeated-call') pair.unshift({ role: 'assistant', content: [call] });
        expect((await post(server, [...messages, ...pair])).status).toBe(422);
        expect((await hint(server)).recovery).toBeNull();
      } finally { await server.close(); }
    });
  it('rejects target substitution and conversation rewind rather than issuing a second resume', async () => {
    const server = await startRuntimeGateway(nonce);
    try {
      const { messages } = await pending(server);
      expect((await post(server, [{ role: 'user', content: `RT_GATE RECOVER ${nonce} another-pane another-session` }, ...messages.slice(1)])).status).toBe(422);
      expect((await post(server, [instruction])).status).toBe(422);
      expect(server.observations.filter(v => v.tool === 'nexus_pane_spawn')).toHaveLength(1);
      expect((await hint(server)).recovery).toBeNull();
    } finally { await server.close(); }
  });
  it('refuses an unadvertised follow-up tool and preserves endpoint authentication', async () => {
    const server = await startRuntimeGateway(nonce);
    try {
      const first = await post(server, [instruction]);
      expect((await post(server, [instruction, { role: 'assistant', content: [first.call] }, result(first.call, pendingReceipt)], ['nexus_pane_spawn'])).status).toBe(422);
      expect((await fetch(`${server.url}/runtime-recovery`)).status).toBe(401);
      expect((await hint(server)).recovery).toBeNull();
    } finally { await server.close(); }
  });
  it('consumes the unchanged 160 request budget while pending without another spawn', async () => {
    const server = await startRuntimeGateway(nonce);
    try {
      const p = await pending(server); let call = p.next.call; const messages = p.messages;
      for (let request = 3; request <= 161; request++) {
        messages.push({ role: 'assistant', content: [call] }, result(call, []));
        const next = await post(server, messages);
        expect(next.status).toBe(request <= 160 ? 200 : 422);
        if (request <= 160) call = next.call;
        else expect(next.text).toContain('runtime fixture request budget exceeded');
      }
      expect((await hint(server)).recovery).toBeNull();
      expect(server.observations.filter(v => v.tool === 'nexus_pane_spawn')).toHaveLength(1);
    } finally { await server.close(); }
  });
});
