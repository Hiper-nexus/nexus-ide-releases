import { describe, expect, it } from 'vitest';
import { startRuntimeGateway } from './runtime-gateway.mjs';
import net from 'node:net';
import { buildToolset } from '../src/main/orch/tools';
import { validateToolArgs } from '../src/main/orch/mcp-args-validation';
import { visualTaskRequirement } from '../src/main/orch/visual-handoff-gate';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopPreviewWithProof, isRunningPreviewUrl } from '../src/main/orch/preview-server';
import { assessBrowserUrl } from '../src/main/browser/url-policy';
it('serves only bounded loopback Anthropic protocol, choosing real advertised Nexus tools', async () => {
  const server = await startRuntimeGateway('11111111-1111-4111-8111-111111111111');
  try {
    const response = await fetch(`${server.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `rt-${server.nonce}` },
      body: JSON.stringify({ model: 'fixture-model', tools: [{ name: 'mcp__nexus__nexus_terminal_run' }], messages: [{ role: 'user', content: 'RT_GATE OPS' }] }) });
    const text = await response.text(); expect(text).toContain('event: message_stop'); expect(text).toContain('mcp__nexus__nexus_terminal_run');
    const missing = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `rt-${server.nonce}` },
      body: JSON.stringify({ model: 'fixture-model', tools: [], messages: [{ role: 'user', content: 'RT_GATE OPS' }] }) });
    expect(missing.status).toBe(422);
    expect((await fetch(`${server.url}/arbitrary`)).status).toBe(404);
    expect((await fetch(`${server.url}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(401);
  } finally { await server.close(); }
});
it('uses actual closed Main ToolDefs and argument validators for controlled inference', async () => {
  const server = await startRuntimeGateway('11111111-1111-4111-8111-111111111111');
  const closedToolDefs = buildToolset();
  try {
    for (const kind of ['OPS', 'SPAWN', 'WRITE', 'REVIEW', 'ACK', 'QUESTION']) {
      const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${server.nonce}` }, body: JSON.stringify({
        model: 'unit-fixture', tools: closedToolDefs.map(t => ({ name: t.name, input_schema: t.inputSchema })), messages: [{ role: 'user', content: `RT_GATE ${kind} ${server.nonce}` }] }) });
      expect(response.status).toBe(200); const events = (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
      const content = events.find(e => e.type === 'content_block_start').content_block;
      const args = JSON.parse(events.find(e => e.delta?.type === 'input_json_delta').delta.partial_json);
      const actual = closedToolDefs.find(t => t.name === content.name); expect(actual).toBeDefined();
      expect(() => validateToolArgs(content.name, args)).not.toThrow();
      for (const required of actual.inputSchema.required ?? []) expect(args[required]).toBeDefined();
      if (kind === 'SPAWN') expect(visualTaskRequirement(args.prompt)?.id).toMatch(/^[a-f0-9-]{36}$/u);
    }
  } finally { await server.close(); }
});

describe('QUESTION waits for the exact clarify and blocked-status results', () => {
  const nonce = '11111111-1111-4111-8111-111111111111';
  const prompt = `RT_QUESTION_${nonce}: select the private fixture route.`;
  const tools = buildToolset().map(t => ({ name: `mcp__nexus__${t.name}`, input_schema: t.inputSchema }));
  const clarify = { missionId: 'mission-real-result', questionId: 'handoff-real-question', question: prompt,
    chips: [{ id: 'opt-1', label: 'Proceed' }, { id: 'opt-2', label: 'Wait' }], allowFreeform: false };
  const callMessage = call => ({ role: 'assistant', content: [call] });
  const resultMessage = (call, value, extra = {}) => ({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: JSON.stringify(value) }], ...extra },
  ] });
  const initial = [{ role: 'user', content: `RT_GATE QUESTION ${nonce}` }];
  async function post(server, messages, advertised = tools) {
    const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
      body: JSON.stringify({ tools: advertised, messages }) });
    const text = await response.text();
    if (response.status !== 200) return { status: response.status, text };
    const events = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    const content = events.find(e => e.type === 'content_block_start').content_block;
    if (content.type === 'tool_use') content.input = JSON.parse(events.find(e => e.delta?.type === 'input_json_delta').delta.partial_json);
    return { status: response.status, text, content };
  }
  async function withClarify(run) {
    const server = await startRuntimeGateway(nonce);
    try {
      const first = await post(server, initial);
      expect(first.content).toMatchObject({ type: 'tool_use', name: 'mcp__nexus__nexus_clarify', input: {
        question: prompt, options: ['Proceed', 'Wait'], allowFreeform: false,
      } });
      await run(server, first.content);
    } finally { await server.close(); }
  }
  it('calls the normal advertised status tool with the returned mission, and completes only after its successful callback', async () => {
    await withClarify(async (server, call) => {
      const messages = [...initial, callMessage(call), resultMessage(call, clarify)];
      // An unrelated JSON result must never supply the mission identity.
      messages.push(resultMessage({ id: 'other-tool' }, { ...clarify, missionId: 'foreign-mission' }));
      const second = await post(server, messages);
      expect(second.content).toMatchObject({ type: 'tool_use', name: 'mcp__nexus__nexus_mission_set_status', input: {
        missionId: 'mission-real-result', status: 'blocked', note: expect.stringContaining(`RT_QUESTION_${nonce}`),
      } });
      expect(Object.keys(second.content.input).sort()).toEqual(['missionId', 'note', 'status']);
      expect(second.content.input.note.length).toBeGreaterThanOrEqual(8);
      expect(() => validateToolArgs('nexus_mission_set_status', second.content.input)).not.toThrow();
      expect(second.text).not.toContain('RT_DONE_QUESTION');
      const done = await post(server, [...messages, callMessage(second.content), resultMessage(second.content, {
        id: clarify.missionId, status: 'blocked', intentState: 'blocked_user', learnings: second.content.input.note,
      })]);
      expect(done.status).toBe(200); expect(done.text).toContain(`RT_DONE_QUESTION_${nonce}`);
      expect(server.observations.map(v => v.tool)).toEqual(['nexus_clarify', 'nexus_mission_set_status']);
    });
  });
  it.each([
    ['missing result', () => []],
    ['wrong result id', () => [resultMessage({ id: 'foreign-tool' }, clarify)]],
    ['ambiguous results', (call) => [resultMessage(call, clarify), resultMessage(call, clarify)]],
    ['failed result', (call) => [resultMessage(call, clarify, { is_error: true })]],
    ['malformed JSON', (call) => [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '{bad' }] }]],
    ['other JSON', (call) => [resultMessage(call, { ok: true, missionId: clarify.missionId })]],
    ['failed success-shaped JSON', (call) => [resultMessage(call, { ...clarify, ok: false })]],
    ['foreign nonce', (call) => [resultMessage(call, { ...clarify, question: 'RT_QUESTION_foreign: select a route.' })]],
    ['invalid chips', (call) => [resultMessage(call, { ...clarify, chips: [{ id: 'same', label: 'Proceed' }, { id: 'same', label: 'Wait' }] })]],
    ['ambiguous JSON content', (call) => [resultMessage(call, clarify, { content: [
      { type: 'text', text: JSON.stringify(clarify) }, { type: 'text', text: JSON.stringify(clarify) },
    ] })]],
  ])('refuses %s without emitting status or completion', async (_label, results) => {
    await withClarify(async (server, call) => {
      const response = await post(server, [...initial, callMessage(call), ...results(call)]);
      expect(response.status).toBe(422); expect(response.text).not.toContain('RT_DONE_QUESTION');
      expect(server.observations.map(v => v.tool)).toEqual(['nexus_clarify']);
    });
  });
  it('refuses a substituted clarify call or an unadvertised status tool', async () => {
    await withClarify(async (server, call) => {
      const substituted = { ...call, name: 'mcp__nexus__nexus_file_read' };
      const wrong = await post(server, [...initial, callMessage(substituted), resultMessage(substituted, clarify)]);
      expect(wrong.status).toBe(422);
      const missing = await post(server, [...initial, callMessage(call), resultMessage(call, clarify)], tools.filter(t => !t.name.endsWith('__nexus_mission_set_status')));
      expect(missing.status).toBe(422); expect(server.observations.map(v => v.tool)).toEqual(['nexus_clarify']);
    });
  });
  it.each(['missing', 'wrong-id', 'failed', 'wrong-mission', 'running', 'no-intent', 'foreign-note'])('does not finish a pending status with %s callback', async (variant) => {
    await withClarify(async (server, call) => {
      const messages = [...initial, callMessage(call), resultMessage(call, clarify)];
      const second = await post(server, messages);
      expect(second.content.type).toBe('tool_use');
      const result = { id: clarify.missionId, status: 'blocked', intentState: 'blocked_user', learnings: second.content.input.note };
      if (variant === 'wrong-mission') result.id = 'foreign-mission';
      if (variant === 'running') result.status = 'running';
      if (variant === 'no-intent') delete result.intentState;
      if (variant === 'foreign-note') result.learnings = 'RT_QUESTION_foreign';
      const callback = variant === 'missing' ? [] : [resultMessage(variant === 'wrong-id' ? { id: 'other-status' } : second.content, result,
        variant === 'failed' ? { is_error: true } : {})];
      const response = await post(server, [...messages, callMessage(second.content), ...callback]);
      expect(response.status).toBe(422); expect(response.text).not.toContain('RT_DONE_QUESTION');
      expect(server.observations).toHaveLength(2);
    });
  });
});
it('physically drains excess/idle loopback sockets and caps an unfinished body before JSON parsing', async () => {
  const server = await startRuntimeGateway('11111111-1111-4111-8111-111111111111');
  const port = new URL(server.url).port, sockets = [];
  try {
    const socket = net.connect(Number(port), '127.0.0.1'); sockets.push(socket); socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write(`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: rt-${server.nonce}\r\nContent-Length: 5000000\r\n\r\n`);
    socket.write(Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('read cap not physical')), 1000))]);
    for (let i = 0; i < 17; i++) { const idle = net.connect(Number(port), '127.0.0.1'); idle.on('error', () => {}); sockets.push(idle); }
    await new Promise(resolve => setTimeout(resolve, 50)); await server.close();
    await new Promise(resolve => setTimeout(resolve, 50)); expect(sockets.every(s => s.destroyed)).toBe(true);
    expect(server.observations).toHaveLength(0);
  } finally { sockets.forEach(s => s.destroy()); await server.close(); }
});

describe('F-1110 ordinary registered preview capture', () => {
  const nonce = '11111111-1111-4111-8111-111111111111';
  const tools = buildToolset();
  const callMessage = call => ({ role: 'assistant', content: [call] });
  const resultMessage = (call, value, extra = {}) => ({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: JSON.stringify(value) }], ...extra },
  ] });
  async function post(server, messages) {
    const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
      body: JSON.stringify({ tools: tools.map(t => ({ name: `mcp__nexus__${t.name}`, input_schema: t.inputSchema })), messages }) });
    const text = await response.text();
    const events = response.ok ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
    const block = events.find(event => event.type === 'content_block_start')?.content_block;
    const input = events.find(event => event.delta?.type === 'input_json_delta');
    return { status: response.status, text, call: block?.type === 'tool_use' ? { ...block, input: JSON.parse(input.delta.partial_json) } : null };
  }
  const initial = [{ role: 'user', content: `RT_GATE WRITE ${nonce}` }];
  it('writes in the execution root, starts a normal preview and captures its exact returned URL', async () => {
    const server = await startRuntimeGateway(nonce), root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-preview-unit-')));
    const scope = { version: 1, identitySource: 'manifest', installationId: 'unit', projectId: 'unit-project', checkoutId: 'unit-checkout', rootRealPath: root };
    const ctx = { role: 'user', scope, readOnly: false, allowedTools: null, allowedSkills: null, label: 'private unit' };
    const messages = [...initial]; let preview;
    try {
      const written = await post(server, messages);
      expect(written.call.name).toBe('mcp__nexus__nexus_file_write');
      expect(written.call.input.path).toBe(`runtime-visual-${nonce}/index.html`);
      expect(written.call.input.content).toContain(`RT_VISUAL_${nonce}`);
      const write = await tools.find(t => t.name === 'nexus_file_write').handler(written.call.input, ctx);
      messages.push(callMessage(written.call), resultMessage(written.call, write));
      const started = await post(server, messages);
      expect(started.call.name).toBe('mcp__nexus__nexus_preview_start');
      expect(started.call.input).toEqual({ dir: `runtime-visual-${nonce}` });
      preview = await tools.find(t => t.name === 'nexus_preview_start').handler(started.call.input, ctx);
      expect(await (await fetch(preview.url)).text()).toContain(`RT_VISUAL_${nonce}`);
      expect((await assessBrowserUrl(preview.url, { allowPrivateNetwork: false, isTrustedPrivateUrl: isRunningPreviewUrl })).allowed).toBe(true);
      expect(await assessBrowserUrl(server.url, { allowPrivateNetwork: false, isTrustedPrivateUrl: isRunningPreviewUrl })).toMatchObject({ allowed: false, kind: 'private-network' });
      messages.push(callMessage(started.call), resultMessage(started.call, preview));
      const opened = await post(server, messages);
      expect(opened.call).toMatchObject({ name: 'mcp__nexus__nexus_browser_open', input: { url: preview.url } });
      messages.push(callMessage(opened.call), resultMessage(opened.call, { ok: true, paneId: 'browser-unit', state: { url: preview.url } }));
      const capture = await post(server, messages);
      expect(capture.call).toMatchObject({ name: 'mcp__nexus__nexus_browser_screenshot', input: { paneId: 'browser-unit' } });
      const captured = { artifactId: 'artifact-unit', sha256: 'a'.repeat(64), path: path.join(root, 'native-unit.png'), width: 320, height: 240, url: preview.url };
      messages.push(callMessage(capture.call), resultMessage(capture.call, captured));
      const report = await post(server, messages);
      expect(report.call).toMatchObject({ name: 'mcp__nexus__nexus_file_write', input: { path: 'runtime-report.txt' } });
      const reportResult = await tools.find(t => t.name === 'nexus_file_write').handler(report.call.input, ctx);
      messages.push(callMessage(report.call), resultMessage(report.call, reportResult));
      const handoff = await post(server, messages);
      expect(handoff.call).toMatchObject({ name: 'mcp__nexus__nexus_handoff_submit', input: {
        artifacts: [{ kind: 'nexus.browser.screenshot', payload: captured }], filesModified: [`runtime-visual-${nonce}/index.html`, 'runtime-report.txt'] } });
      expect((await fetch(`${server.url}/runtime-page`)).status).toBe(404);
    } finally { if (preview) await stopPreviewWithProof(preview.id, scope); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['missing', 'wrong-id', 'failed', 'duplicate', 'foreign-path'])('does not start a preview after a %s file write result', async variant => {
    const server = await startRuntimeGateway(nonce);
    try {
      const first = await post(server, initial);
      expect(first.call.name).toBe('mcp__nexus__nexus_file_write');
      const result = resultMessage(variant === 'wrong-id' ? { id: 'foreign-write' } : first.call,
        { path: variant === 'foreign-path' ? 'outside/index.html' : first.call.input.path }, variant === 'failed' ? { is_error: true } : {});
      const callbacks = variant === 'missing' ? [] : variant === 'duplicate' ? [result, result] : [result];
      const next = await post(server, [...initial, callMessage(first.call), ...callbacks]);
      expect(next.status).toBe(422); expect(server.observations).toHaveLength(1);
    } finally { await server.close(); }
  });
  it.each(['missing', 'wrong-id', 'failed', 'duplicate', 'foreign-url', 'wrong-port'])('never opens a browser from a %s preview result', async variant => {
    const server = await startRuntimeGateway(nonce);
    try {
      const first = await post(server, initial);
      expect(first.call.name).toBe('mcp__nexus__nexus_file_write');
      const messages = [...initial, callMessage(first.call), resultMessage(first.call, { path: first.call.input.path })];
      const second = await post(server, messages);
      const value = { id: 'preview-unit', url: variant === 'foreign-url' ? 'https://foreign.invalid/' : 'http://127.0.0.1:43123/', port: variant === 'wrong-port' ? 43124 : 43123 };
      const result = resultMessage(variant === 'wrong-id' ? { id: 'foreign-preview' } : second.call, value, variant === 'failed' ? { is_error: true } : {});
      const callbacks = variant === 'missing' ? [] : variant === 'duplicate' ? [result, result] : [result];
      const next = await post(server, [...messages, callMessage(second.call), ...callbacks]);
      expect(next.status).toBe(422); expect(server.observations).toHaveLength(2);
    } finally { await server.close(); }
  });
});
describe('F-1111 normal worker recovery exchange', () => {
  const nonce = '11111111-1111-4111-8111-111111111111';
  const initial = [{ role: 'user', content: `RT_GATE RECOVER ${nonce} pane-old session-old` }];
  async function post(server, messages) {
    const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
      body: JSON.stringify({ tools: buildToolset().map(t => ({ name: `mcp__nexus__${t.name}` })), messages }) });
    const text = await response.text(), events = response.ok ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
    const call = events.find(event => event.type === 'content_block_start')?.content_block;
    if (call?.type === 'tool_use') call.input = JSON.parse(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json);
    return { status: response.status, call };
  }
  it.each(['valid', 'missing', 'wrong-id', 'failed', 'duplicate', 'old-pane', 'old-session'])(
    'binds only the successful actual new spawn result (%s)', async variant => {
      const server = await startRuntimeGateway(nonce);
      try {
        const first = await post(server, initial);
        expect(first.call).toMatchObject({ name: 'mcp__nexus__nexus_pane_spawn', input: {
          resume: 'pane-old', agentName: 'Runtime writer', role: 'worker', autoCloseOnHandoff: false } });
        const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: variant === 'wrong-id' ? 'foreign-call' : first.call.id,
          is_error: variant === 'failed', content: JSON.stringify({
            paneId: variant === 'old-pane' ? 'pane-old' : 'pane-new', sessionId: variant === 'old-session' ? 'session-old' : 'session-new' }) }] };
        const callbacks = variant === 'missing' ? [] : variant === 'duplicate' ? [result, result] : [result];
        const next = await post(server, [...initial, { role: 'assistant', content: [first.call] }, ...callbacks]);
        expect(next.status).toBe(variant === 'valid' ? 200 : 422);
        expect((await fetch(`${server.url}/runtime-recovery`)).status).toBe(401);
        const hint = await (await fetch(`${server.url}/runtime-recovery`, { headers: { 'x-api-key': `rt-${nonce}` } })).json();
        expect(hint).toEqual({ nonce, pid: process.pid, recovery: variant === 'valid' ? {
          fromPaneId: 'pane-old', fromSessionId: 'session-old', paneId: 'pane-new', sessionId: 'session-new' } : null });
      } finally { await server.close(); }
    });
});
