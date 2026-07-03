import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  LEGACY_MARKER,
  LegacyHandoffParser,
  type LegacyHandoffPayload,
} from './legacy-handoff';

function collect(): {
  parser: LegacyHandoffParser;
  received: Array<{ sessionId: string; payload: LegacyHandoffPayload }>;
} {
  const received: Array<{ sessionId: string; payload: LegacyHandoffPayload }> =
    [];
  const parser = new LegacyHandoffParser((sessionId, payload) =>
    received.push({ sessionId, payload }),
  );
  return { parser, received };
}

describe('extractJsonObject', () => {
  it('extracts a balanced object and reports the end offset', () => {
    const text = 'noise {"a": {"b": 1}} trailing';
    const result = extractJsonObject(text);
    expect(result?.value).toEqual({ a: { b: 1 } });
    expect(text.slice(result!.end)).toBe(' trailing');
  });

  it('ignores braces inside strings', () => {
    const result = extractJsonObject('{"s": "close } brace {"}');
    expect(result?.value).toEqual({ s: 'close } brace {' });
  });

  it('returns null while the object is incomplete', () => {
    expect(extractJsonObject('{"a": 1, ')).toBeNull();
  });
});

describe('LegacyHandoffParser', () => {
  const block =
    `${LEGACY_MARKER}\n` +
    '{"status": "success", "summary": "done the thing", "artifacts": ["a.ts"]}\n';

  it('parses a complete legacy handoff block', () => {
    const { parser, received } = collect();
    parser.feed('s1', `regular output\n${block}more output`);
    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe('s1');
    expect(received[0].payload).toEqual({
      status: 'success',
      summary: 'done the thing',
      artifacts: ['a.ts'],
    });
  });

  it('detects a marker split across chunks', () => {
    const { parser, received } = collect();
    const full = block;
    const mid = Math.floor(LEGACY_MARKER.length / 2);
    parser.feed('s1', `prefix ${full.slice(0, mid)}`);
    parser.feed('s1', full.slice(mid));
    expect(received).toHaveLength(1);
  });

  it('buffers JSON split across chunks', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "partial",`);
    expect(received).toHaveLength(0);
    parser.feed('s1', ' "summary": "half done"}');
    expect(received).toHaveLength(1);
    expect(received[0].payload.status).toBe('partial');
    expect(received[0].payload.artifacts).toEqual([]);
  });

  it('drops payloads with invalid status or missing summary', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "weird", "summary": "x"}`);
    parser.feed('s2', `${LEGACY_MARKER}\n{"status": "success"}`);
    expect(received).toHaveLength(0);
  });

  it('keeps sessions independent and handles multiple blocks per session', () => {
    const { parser, received } = collect();
    parser.feed('s1', block);
    parser.feed('s2', 'no marker here');
    parser.feed('s1', `${LEGACY_MARKER}\n{"status":"failed","summary":"broke"}`);
    expect(received.map((r) => [r.sessionId, r.payload.status])).toEqual([
      ['s1', 'success'],
      ['s1', 'failed'],
    ]);
  });

  it('abandons an unterminated block instead of buffering forever', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "success", "summary": "`);
    parser.feed('s1', 'x'.repeat(20_000));
    parser.feed('s1', '"}');
    expect(received).toHaveLength(0);
  });
});
