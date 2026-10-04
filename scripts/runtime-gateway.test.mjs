import { expect, it } from 'vitest';
import { startRuntimeGateway } from './runtime-gateway.mjs';
import net from 'node:net';
import { buildToolset } from '../src/main/orch/tools';
import { validateToolArgs } from '../src/main/orch/mcp-args-validation';
import { visualTaskRequirement } from '../src/main/orch/visual-handoff-gate';
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
        model: 'unit-fixture', tools: closedToolDefs.map(t => ({ name: t.name, input_schema: t.inputSchema })), messages: [{ role: 'user', content: `RT_GATE ${kind}` }] }) });
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
