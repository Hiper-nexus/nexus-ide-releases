/**
 * TDD suite for the ACP client, driven against a REAL subprocess: an inline
 * fake peer (Node script written to a temp dir) that speaks ACP on the other
 * side of stdio. No mocks — every fault path is a real process being abused,
 * following buzz-agent's test strategy.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AcpClient, AcpClientError, type AcpTurnEvent } from './acp-client';

/**
 * The fake ACP peer. Behavior selected via argv[2]:
 *  - happy:              full transcript (init → session → chunks/tools → end_turn)
 *  - hang-init:          reads stdin but never answers anything
 *  - hang-prompt:        answers init/session, then goes silent on prompt
 *  - die-mid-turn:       emits one chunk then exits(17) mid-turn
 *  - stream-until-cancel: emits chunks forever until session/cancel arrives
 */
const FAKE_PEER_SOURCE = `
import readline from 'node:readline';

const behavior = process.argv[2] ?? 'happy';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let promptId = null;
let promptSessionId = null;
let streamTimer = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (behavior === 'hang-init') return;

  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'fake-acp-peer', version: '0.0.1' },
    } });
    return;
  }

  if (method === 'session/new') {
    write({ jsonrpc: '2.0', id, result: { sessionId: 'ses_fake_0001' } });
    return;
  }

  if (method === 'session/prompt') {
    // hang-prompt never records the prompt, so session/cancel is ignored
    // too — the peer is fully unresponsive mid-turn.
    if (behavior === 'hang-prompt') return;
    promptId = id;
    promptSessionId = params.sessionId;
    const update = (u) => write({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: promptSessionId, update: u } });

    if (behavior === 'die-mid-turn') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial…' } });
      setTimeout(() => process.exit(17), 30);
      return;
    }

    if (behavior === 'stream-until-cancel') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tick' } });
      streamTimer = setInterval(() => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tick' } });
      }, 40);
      return;
    }

    // happy path — mirrors the buzz-agent README transcript
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_01', title: 'echo__say',
      kind: 'other', status: 'pending', rawInput: { text: 'hello' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }] });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (method === 'session/cancel') {
    if (streamTimer) clearInterval(streamTimer);
    if (promptId !== null) {
      write({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
      promptId = null;
    }
    return;
  }

  if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
`;

let fixtureDir = '';
let fakePeerPath = '';

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-acp-fake-peer-'));
  fakePeerPath = path.join(fixtureDir, 'fake-acp-peer.mjs');
  await writeFile(fakePeerPath, FAKE_PEER_SOURCE, 'utf8');
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function spawnFakePeer(behavior: string): AcpClient {
  return AcpClient.spawn({
    command: process.execPath,
    args: [fakePeerPath, behavior],
    cwd: fixtureDir,
  });
}

async function expectPeerDead(client: AcpClient): Promise<void> {
  const exit = await client.waitForExit(3_000);
  expect(exit).not.toBeNull();
  const pid = client.pid;
  if (pid === undefined) return;
  // ESRCH proves the group leader is gone (kill 0 only probes existence).
  expect(() => process.kill(pid, 0)).toThrow();
}

async function collectTurn(
  events: AsyncIterable<AcpTurnEvent>,
): Promise<AcpTurnEvent[]> {
  const collected: AcpTurnEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('AcpClient — handshake', () => {
  test('initialize negotiates version and returns typed agent info', async () => {
    // Arrange
    const client = spawnFakePeer('happy');

    try {
      // Act
      const result = await client.initialize();

      // Assert
      expect(result.protocolVersion).toBe(1);
      expect(result.agentInfo).toEqual({ name: 'fake-acp-peer', version: '0.0.1' });
      expect(result.agentCapabilities.loadSession).toBe(false);
      expect(result.agentCapabilities.mcpCapabilities?.http).toBe(false);
    } finally {
      await client.shutdown();
    }
  });

  test('session/new returns the sessionId', async () => {
    const client = spawnFakePeer('happy');

    try {
      await client.initialize();
      const sessionId = await client.sessionNew(fixtureDir, []);

      expect(sessionId).toBe('ses_fake_0001');
    } finally {
      await client.shutdown();
    }
  });

  test('peer that hangs at handshake → request-timeout kills and reports', async () => {
    // Arrange — tight timeout so the test stays fast
    const client = AcpClient.spawn({
      command: process.execPath,
      args: [fakePeerPath, 'hang-init'],
      requestTimeoutMs: 300,
    });

    // Act + Assert
    await expect(client.initialize()).rejects.toMatchObject({
      code: 'request-timeout',
    });
    await expectPeerDead(client);
  });
});

describe('AcpClient — prompt turn', () => {
  test('prompt streams typed chunks and tool calls, then stopReason end_turn', async () => {
    // Arrange
    const client = spawnFakePeer('happy');

    try {
      await client.initialize();
      const sessionId = await client.sessionNew(fixtureDir);

      // Act
      const events = await collectTurn(client.prompt(sessionId, 'echo hello'));

      // Assert — updates in order, exactly one terminal stop event
      const updates = events.filter((event) => event.type === 'update');
      const stops = events.filter((event) => event.type === 'stop');
      expect(stops).toEqual([{ type: 'stop', stopReason: 'end_turn' }]);
      expect(events[events.length - 1]).toEqual(stops[0]);

      const kinds = updates.map((event) =>
        event.type === 'update' ? event.update.sessionUpdate : 'stop',
      );
      expect(kinds).toEqual([
        'agent_message_chunk',
        'tool_call',
        'tool_call_update',
        'tool_call_update',
        'agent_message_chunk',
      ]);

      const text = updates
        .flatMap((event) =>
          event.type === 'update' &&
          event.update.sessionUpdate === 'agent_message_chunk'
            ? [event.update.content.text]
            : [],
        )
        .join('');
      expect(text).toBe('hello world');
    } finally {
      await client.shutdown();
    }
  });

  test('a second prompt while one is in flight is rejected explicitly', async () => {
    const client = spawnFakePeer('stream-until-cancel');

    try {
      await client.initialize();
      const sessionId = await client.sessionNew(fixtureDir);
      const turn = client.prompt(sessionId, 'first', { idleTimeoutMs: 5_000 });

      expect(() => client.prompt(sessionId, 'second')).toThrow(AcpClientError);

      await turn.cancel();
      await collectTurn(turn);
    } finally {
      await client.shutdown();
    }
  });
});

describe('AcpClient — bounded failure paths (never hangs)', () => {
  test('peer that goes silent mid-prompt → idle timeout kills group and reports', async () => {
    // Arrange
    const client = spawnFakePeer('hang-prompt');
    await client.initialize();
    const sessionId = await client.sessionNew(fixtureDir);

    // Act + Assert — iterator throws, it never blocks forever
    await expect(
      collectTurn(client.prompt(sessionId, 'hang please', { idleTimeoutMs: 250 })),
    ).rejects.toMatchObject({ code: 'idle-timeout' });

    // The whole process group must be dead after the timeout.
    await expectPeerDead(client);
    expect(client.disposed).toBe(true);
  });

  test('hard turn cap fires even while the peer keeps streaming', async () => {
    const client = spawnFakePeer('stream-until-cancel');
    await client.initialize();
    const sessionId = await client.sessionNew(fixtureDir);

    await expect(
      collectTurn(
        client.prompt(sessionId, 'stream forever', {
          idleTimeoutMs: 5_000,
          maxDurationMs: 400,
        }),
      ),
    ).rejects.toMatchObject({ code: 'hard-timeout' });

    await expectPeerDead(client);
  });

  test('peer that dies mid-turn → explicit peer-exited error with exit code', async () => {
    // Arrange
    const client = spawnFakePeer('die-mid-turn');
    await client.initialize();
    const sessionId = await client.sessionNew(fixtureDir);

    // Act
    const events: AcpTurnEvent[] = [];
    let caught: unknown = null;
    try {
      for await (const event of client.prompt(sessionId, 'die on me')) {
        events.push(event);
      }
    } catch (error: unknown) {
      caught = error;
    }

    // Assert — the chunk emitted before death was delivered, then the error
    expect(events).toEqual([
      {
        type: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial…' },
        },
      },
    ]);
    expect(caught).toBeInstanceOf(AcpClientError);
    if (caught instanceof AcpClientError) {
      expect(caught.code).toBe('peer-exited');
      expect(caught.message).toContain('17');
    }
    await expectPeerDead(client);
  });

  test('requests after disposal fail fast with disposed', async () => {
    const client = spawnFakePeer('happy');
    await client.initialize();
    await client.shutdown();

    await expect(client.sessionNew(fixtureDir)).rejects.toMatchObject({
      code: 'disposed',
    });
  });
});

describe('AcpClient — cancel', () => {
  test('cancel stops a streaming turn with stopReason cancelled', async () => {
    // Arrange
    const client = spawnFakePeer('stream-until-cancel');

    try {
      await client.initialize();
      const sessionId = await client.sessionNew(fixtureDir);
      const turn = client.prompt(sessionId, 'stream', { idleTimeoutMs: 5_000 });

      // Act — consume a couple of chunks, then cancel from inside the loop
      const events: AcpTurnEvent[] = [];
      for await (const event of turn) {
        events.push(event);
        if (events.filter((item) => item.type === 'update').length === 2) {
          await turn.cancel();
        }
      }

      // Assert — clean cancelled stop, no error thrown, client still usable
      const last = events[events.length - 1];
      expect(last).toEqual({ type: 'stop', stopReason: 'cancelled' });
      expect(client.disposed).toBe(false);
    } finally {
      await client.shutdown();
    }
  });

  test('cancel on a peer that ignores it → cancel-drain-timeout kills group', async () => {
    // Arrange — hang-prompt swallows session/cancel (never answers)
    const client = AcpClient.spawn({
      command: process.execPath,
      args: [fakePeerPath, 'hang-prompt'],
      cancelDrainTimeoutMs: 300,
    });
    await client.initialize();
    const sessionId = await client.sessionNew(fixtureDir);
    const turn = client.prompt(sessionId, 'ignore my cancel', {
      idleTimeoutMs: 10_000,
    });

    // Act
    await turn.cancel();

    // Assert — bounded drain, then the group dies
    await expect(collectTurn(turn)).rejects.toMatchObject({
      code: 'cancel-drain-timeout',
    });
    await expectPeerDead(client);
  });

  test('cancel with no in-flight turn is a safe no-op', async () => {
    const client = spawnFakePeer('happy');

    try {
      await client.initialize();
      const sessionId = await client.sessionNew(fixtureDir);

      await expect(client.cancel(sessionId)).resolves.toBeUndefined();
    } finally {
      await client.shutdown();
    }
  });
});
