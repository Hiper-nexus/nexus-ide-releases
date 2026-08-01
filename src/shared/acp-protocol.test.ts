/**
 * Tests for the ACP wire parser. Frames marked "transcript" are verbatim
 * lines from the buzz-agent README's documented ACP round-trip.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0).
 */

import { describe, expect, test } from 'vitest';

import {
  AcpNdjsonDecoder,
  buildErrorResponseFrame,
  buildNotificationFrame,
  buildRequestFrame,
  parseAcpLine,
  parseAcpStopReason,
  parseInitializeResult,
  parseSessionNewResult,
  parseSessionPromptResult,
} from './acp-protocol';

const SESSION = 'ses_a1b2c3d4e5f6a7b8';

describe('parseAcpLine — transcript frames', () => {
  test('parses the initialize response', () => {
    // Arrange (transcript step 1, agent → client)
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: 'buzz-agent', version: '0.1.0' },
      },
    });

    // Act
    const parsed = parseAcpLine(line);

    // Assert
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.kind).toBe('response');
    if (parsed.message.kind !== 'response') return;
    expect(parsed.message.id).toBe(1);
    const result = parseInitializeResult(parsed.message.result);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protocolVersion).toBe(1);
    expect(result.value.agentInfo?.name).toBe('buzz-agent');
    expect(result.value.agentCapabilities.loadSession).toBe(false);
  });

  test('parses the session/new response into a sessionId', () => {
    const line = `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"${SESSION}"}}`;

    const parsed = parseAcpLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'response') throw new Error('bad kind');
    const result = parseSessionNewResult(parsed.message.result);
    expect(result).toEqual({ ok: true, value: { sessionId: SESSION } });
  });

  test('rejects an initialize response for another protocol version', () => {
    expect(
      parseInitializeResult({
        protocolVersion: 2,
        agentCapabilities: {},
      }),
    ).toEqual({
      ok: false,
      detail: 'initialize protocolVersion 2 is incompatible with 1',
    });
  });

  test('parses a tool_call session/update (transcript step 4)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'toolu_01XYZ',
          title: 'echo__say',
          kind: 'other',
          status: 'pending',
          rawInput: { text: 'hello' },
        },
      },
    });

    const parsed = parseAcpLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'session-update') {
      throw new Error('bad kind');
    }
    expect(parsed.message.sessionId).toBe(SESSION);
    const update = parsed.message.update;
    expect(update.sessionUpdate).toBe('tool_call');
    if (update.sessionUpdate !== 'tool_call') return;
    expect(update.toolCallId).toBe('toolu_01XYZ');
    expect(update.title).toBe('echo__say');
    expect(update.status).toBe('pending');
    expect(update.rawInput).toEqual({ text: 'hello' });
  });

  test('parses a tool_call_update with completed status and content', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'toolu_01XYZ',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
        },
      },
    });

    const parsed = parseAcpLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'session-update') {
      throw new Error('bad kind');
    }
    const update = parsed.message.update;
    if (update.sessionUpdate !== 'tool_call_update') throw new Error('bad update');
    expect(update.status).toBe('completed');
    expect(Array.isArray(update.content)).toBe(true);
  });

  test('parses an agent_message_chunk with text content', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello world' },
        },
      },
    });

    const parsed = parseAcpLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'session-update') {
      throw new Error('bad kind');
    }
    const update = parsed.message.update;
    if (update.sessionUpdate !== 'agent_message_chunk') throw new Error('bad update');
    expect(update.content.text).toBe('hello world');
  });

  test('parses the final prompt response into a stopReason (transcript step 8)', () => {
    const line = `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`;

    const parsed = parseAcpLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'response') throw new Error('bad kind');
    expect(parseSessionPromptResult(parsed.message.result)).toEqual({
      ok: true,
      value: 'end_turn',
    });
  });
});

describe('parseAcpLine — classification and explicit errors', () => {
  test('classifies an agent-initiated request (session/request_permission)', () => {
    const parsed = parseAcpLine(
      `{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"${SESSION}"}}`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message).toMatchObject({
      kind: 'agent-request',
      id: 'perm-1',
      method: 'session/request_permission',
    });
  });

  test('classifies an unknown notification without id', () => {
    const parsed = parseAcpLine(
      '{"jsonrpc":"2.0","method":"_goose/unstable/session/update","params":{}}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.kind).toBe('agent-notification');
  });

  test('classifies a JSON-RPC error response, preserving the code', () => {
    const parsed = parseAcpLine(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'error-response') {
      throw new Error('bad kind');
    }
    expect(parsed.message.code).toBe(-32601);
    expect(parsed.message.message).toBe('Method not found');
  });

  test('error response without message falls back to full error object', () => {
    const parsed = parseAcpLine(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"data":{"provider":"x"}}}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'error-response') {
      throw new Error('bad kind');
    }
    expect(parsed.message.message).toContain('provider');
  });

  test('rejects invalid JSON with an explicit error', () => {
    const parsed = parseAcpLine('{"jsonrpc":"2.0", broken');

    expect(parsed).toMatchObject({ ok: false, error: { code: 'invalid-json' } });
  });

  test('rejects an empty line', () => {
    expect(parseAcpLine('   ')).toMatchObject({
      ok: false,
      error: { code: 'empty-line' },
    });
  });

  test('rejects non-object frames', () => {
    expect(parseAcpLine('[1,2,3]')).toMatchObject({
      ok: false,
      error: { code: 'not-an-object' },
    });
  });

  test('rejects frames without jsonrpc 2.0 marker', () => {
    expect(parseAcpLine('{"id":1,"result":{}}')).toMatchObject({
      ok: false,
      error: { code: 'missing-jsonrpc-version' },
    });
  });

  test('rejects a session/update missing sessionId', () => {
    const parsed = parseAcpLine(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
    );

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'malformed-session-update' },
    });
  });

  test('rejects a tool_call without toolCallId', () => {
    const parsed = parseAcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: SESSION,
          update: { sessionUpdate: 'tool_call', title: 'x', status: 'pending' },
        },
      }),
    );

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'malformed-session-update' },
    });
  });

  test('rejects a response with no id', () => {
    expect(parseAcpLine('{"jsonrpc":"2.0","result":{}}')).toMatchObject({
      ok: false,
      error: { code: 'malformed-response' },
    });
  });

  test('rejects an oversized line explicitly', () => {
    const line = `{"jsonrpc":"2.0","id":1,"result":{"pad":"${'x'.repeat(300)}"}}`;

    expect(parseAcpLine(line, 128)).toMatchObject({
      ok: false,
      error: { code: 'line-too-long', maxBytes: 128 },
    });
  });

  test('preserves unknown update kinds instead of erroring', () => {
    const parsed = parseAcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: SESSION,
          update: { sessionUpdate: 'session_info_update', activeRunId: 'run-1' },
        },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.kind !== 'session-update') {
      throw new Error('bad kind');
    }
    expect(parsed.message.update).toMatchObject({
      sessionUpdate: 'unrecognized',
      wireKind: 'session_info_update',
    });
  });
});

describe('parseAcpStopReason', () => {
  test('accepts all documented reasons case-insensitively', () => {
    expect(parseAcpStopReason('end_turn')).toBe('end_turn');
    expect(parseAcpStopReason('END_TURN')).toBe('end_turn');
    expect(parseAcpStopReason('Cancelled')).toBe('cancelled');
    expect(parseAcpStopReason('max_tokens')).toBe('max_tokens');
    expect(parseAcpStopReason('max_turn_requests')).toBe('max_turn_requests');
    expect(parseAcpStopReason('refusal')).toBe('refusal');
  });

  test('returns null for unknown or non-string values', () => {
    expect(parseAcpStopReason('exploded')).toBeNull();
    expect(parseAcpStopReason(42)).toBeNull();
    expect(parseAcpStopReason(undefined)).toBeNull();
  });

  test('unknown stopReason in a prompt result is an explicit error', () => {
    const result = parseSessionPromptResult({ stopReason: 'wat' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('wat');
  });
});

describe('frame builders', () => {
  test('requests carry id, notifications never do', () => {
    const request: unknown = JSON.parse(buildRequestFrame(5, 'initialize', {}));
    const notification: unknown = JSON.parse(
      buildNotificationFrame('session/cancel', { sessionId: SESSION }),
    );

    expect(request).toMatchObject({ jsonrpc: '2.0', id: 5, method: 'initialize' });
    expect(notification).toMatchObject({ jsonrpc: '2.0', method: 'session/cancel' });
    expect(Object.keys(notification as Record<string, unknown>)).not.toContain('id');
  });

  test('frames are newline-terminated (NDJSON)', () => {
    expect(buildRequestFrame(1, 'initialize', {}).endsWith('\n')).toBe(true);
    expect(buildErrorResponseFrame(1, -32601, 'nope').endsWith('\n')).toBe(true);
  });
});

describe('AcpNdjsonDecoder', () => {
  test('reassembles frames split across arbitrary chunk boundaries', () => {
    // Arrange
    const decoder = new AcpNdjsonDecoder();
    const frame = `{"jsonrpc":"2.0","id":1,"result":{"sessionId":"${SESSION}"}}\n`;

    // Act — feed one byte at a time
    const lines: string[] = [];
    for (const char of frame) {
      const pushed = decoder.push(char);
      lines.push(...pushed.lines);
      expect(pushed.fatal).toBeNull();
    }

    // Assert
    expect(lines).toHaveLength(1);
    expect(parseAcpLine(lines[0]).ok).toBe(true);
  });

  test('handles multiple frames in one chunk and strips CR', () => {
    const decoder = new AcpNdjsonDecoder();

    const { lines, fatal } = decoder.push(
      '{"jsonrpc":"2.0","id":1,"result":{}}\r\n{"jsonrpc":"2.0","id":2,"result":{}}\n',
    );

    expect(fatal).toBeNull();
    expect(lines).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{}}',
    ]);
  });

  test('decodes multi-byte UTF-8 split across chunk boundaries', () => {
    const decoder = new AcpNdjsonDecoder();
    const bytes = new TextEncoder().encode(
      '{"jsonrpc":"2.0","id":1,"result":{"text":"olá coração"}}\n',
    );
    const splitAt = 42; // inside the multi-byte region

    const first = decoder.push(bytes.slice(0, splitAt));
    const second = decoder.push(bytes.slice(splitAt));

    const lines = [...first.lines, ...second.lines];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('olá coração');
  });

  test('poisons on a newline-less flood past the byte cap (rogue peer)', () => {
    const decoder = new AcpNdjsonDecoder(64);

    const result = decoder.push('x'.repeat(100));

    expect(result.fatal).toMatchObject({ code: 'line-too-long', maxBytes: 64 });
    expect(decoder.poisoned).toBe(true);
    // Subsequent pushes stay fatal — the stream is dead.
    expect(decoder.push('more').fatal).not.toBeNull();
  });

  test('poisons on a single oversized terminated line', () => {
    const decoder = new AcpNdjsonDecoder(64);

    const result = decoder.push(`${'y'.repeat(100)}\n`);

    expect(result.lines).toHaveLength(0);
    expect(result.fatal).toMatchObject({ code: 'line-too-long' });
  });
});
