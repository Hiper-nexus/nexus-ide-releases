import { describe, expect, it } from 'vitest';
import {
  CodexFileIngest,
  legacyCodexUsageMessageId,
  parseCodexLine,
} from './codex-transcript';

const META = JSON.stringify({
  type: 'session_meta',
  timestamp: '2026-07-05T16:00:00.000Z',
  payload: { session_id: 'codex-sess-1', cwd: '/Users/x/nexus-ide' },
});

const TURN_CONTEXT = JSON.stringify({
  type: 'turn_context',
  payload: { model: 'gpt-5.5', cwd: '/Users/x/nexus-ide' },
});

const TOKEN_COUNT = JSON.stringify({
  type: 'event_msg',
  timestamp: '2026-07-05T16:54:17.773Z',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: 22615,
        cached_input_tokens: 4992,
        output_tokens: 578,
        reasoning_output_tokens: 307,
        total_tokens: 23193,
      },
      total_token_usage: { input_tokens: 999999 },
    },
  },
});

describe('parseCodexLine', () => {
  it('extrai session_meta com cwd', () => {
    expect(parseCodexLine(META)).toEqual({
      kind: 'meta',
      meta: {
        sessionId: 'codex-sess-1',
        threadId: 'codex-sess-1',
        cwd: '/Users/x/nexus-ide',
      },
    });
  });

  it('separa o thread físico do provider session herdado do agente pai', () => {
    const childMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-05T17:00:01.000Z',
      payload: {
        id: 'thread-filho',
        session_id: 'thread-pai',
        parent_thread_id: 'thread-pai',
        timestamp: '2026-07-05T17:00:00.000Z',
        cwd: '/Users/x/nexus-ide',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'thread-pai' },
          },
        },
      },
    });

    expect(parseCodexLine(childMeta)).toEqual({
      kind: 'meta',
      meta: {
        sessionId: 'thread-pai',
        threadId: 'thread-filho',
        parentThreadId: 'thread-pai',
        startedAt: Date.parse('2026-07-05T17:00:00.000Z'),
        cwd: '/Users/x/nexus-ide',
      },
    });
  });

  it('extrai modelo do turn_context', () => {
    expect(parseCodexLine(TURN_CONTEXT)).toEqual({ kind: 'model', model: 'gpt-5.5' });
  });

  it('usa last_token_usage e separa cached do input', () => {
    const parsed = parseCodexLine(TOKEN_COUNT);
    expect(parsed?.kind).toBe('usage');
    if (parsed?.kind !== 'usage') return;
    expect(parsed.usage.inputTokens).toBe(22615 - 4992);
    expect(parsed.usage.cacheReadTokens).toBe(4992);
    expect(parsed.usage.outputTokens).toBe(578);
    expect(parsed.usage.messageId).toBe('codex:2026-07-05T16:54:17.773Z');
  });

  it('ignora lixo e eventos irrelevantes sem lançar', () => {
    expect(parseCodexLine('nao é json')).toBeNull();
    expect(parseCodexLine('{"type":"response_item","payload":{"role":"user"}}')).toBeNull();
    expect(parseCodexLine('{"type":"event_msg","payload":{"type":"turn_started"}}')).toBeNull();
  });
});

describe('CodexFileIngest', () => {
  it('costura sessão + modelo nos eventos de uso', () => {
    const ingest = new CodexFileIngest();
    expect(ingest.ingestLine(META)).toBeNull();
    expect(ingest.ingestLine(TURN_CONTEXT)).toBeNull();
    const ev = ingest.ingestLine(TOKEN_COUNT);
    expect(ev).toMatchObject({
      sessionId: 'codex-sess-1',
      model: 'gpt-5.5',
      inputTokens: 17623,
      cacheReadTokens: 4992,
      outputTokens: 578,
      cacheWrite5mTokens: 0,
    });
    expect(ingest.cwd).toBe('/Users/x/nexus-ide');
  });

  it('descarta uso antes do session_meta (inatribuível)', () => {
    const ingest = new CodexFileIngest();
    expect(ingest.ingestLine(TOKEN_COUNT)).toBeNull();
  });

  it('id sintético é determinístico → re-ingest idempotente no dedupe', () => {
    const a = new CodexFileIngest();
    a.ingestLine(META);
    const b = new CodexFileIngest();
    b.ingestLine(META);
    const first = a.ingestLine(TOKEN_COUNT)?.messageId;
    expect(first).toBe(b.ingestLine(TOKEN_COUNT)?.messageId);
    expect(first).toMatch(
      /^codex:v2:[a-f0-9]{64}:1:2026-07-05T16:54:17\.773Z$/,
    );
    expect(legacyCodexUsageMessageId(first!)).toBe(
      'codex:2026-07-05T16:54:17.773Z',
    );
  });

  it('mantém distintos dois token_count da mesma sessão no mesmo milissegundo', () => {
    const ingest = new CodexFileIngest();
    ingest.ingestLine(META);
    const first = ingest.ingestLine(TOKEN_COUNT);
    const second = ingest.ingestLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-05T16:54:17.773Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 10,
              output_tokens: 7,
            },
          },
        },
      }),
    );

    expect(first?.messageId).toMatch(/:1:2026-07-05T16:54:17\.773Z$/);
    expect(second?.messageId).toMatch(/:2:2026-07-05T16:54:17\.773Z$/);
    expect(first?.messageId).not.toBe(second?.messageId);
  });

  it('separa threads físicos que compartilham provider session e timestamp', () => {
    const ingestForThread = (
      threadId: string,
      turnId: string,
    ): CodexFileIngest => {
      const ingest = new CodexFileIngest();
      ingest.ingestLine(
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: threadId,
            session_id: 'provider-session-pai',
            timestamp: '2026-07-05T16:00:00.000Z',
            cwd: '/workspace',
          },
        }),
      );
      ingest.ingestLine(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: turnId,
            started_at: 1_785_321_800,
          },
        }),
      );
      return ingest;
    };
    const first = ingestForThread(
      '019fad78-bf8f-7b63-837f-750b9c02bcd3',
      '019fad78-c243-7c10-957a-9b08377e4fed',
    ).ingestLine(TOKEN_COUNT);
    const second = ingestForThread(
      '019fad78-bf90-7b63-837f-750b9c02bcd3',
      '019fad78-c244-7c10-957a-9b08377e4fed',
    ).ingestLine(TOKEN_COUNT);

    expect(first?.sessionId).toBe(second?.sessionId);
    expect(first?.messageId).not.toBe(second?.messageId);
  });

  it('mantém o primeiro session_meta e ignora o histórico copiado do pai', () => {
    const child = new CodexFileIngest();
    child.ingestLine(
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: '019fad78-bf8f-7b63-837f-750b9c02bcd3',
          session_id: '019fab5d-b0bc-7fc1-ac78-510e35abbc48',
          parent_thread_id: '019fab5d-b0bc-7fc1-ac78-510e35abbc48',
          timestamp: '2026-07-29T10:43:19.590Z',
          cwd: '/workspace/filho',
        },
      }),
    );
    child.ingestLine(META);

    child.ingestLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-29T10:43:19.987Z',
        payload: {
          type: 'task_started',
          turn_id: '019fab5e-ee23-77e0-a9a8-3434e9581ec0',
          started_at: 1_785_286_553,
        },
      }),
    );
    expect(
      child.ingestLine(
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T10:43:19.988Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 99_999,
                cached_input_tokens: 1,
                output_tokens: 9_999,
              },
            },
          },
        }),
      ),
    ).toBeNull();
    child.ingestLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-29T10:43:20.262Z',
        payload: {
          type: 'task_started',
          turn_id: '019fad78-c243-7c10-957a-9b08377e4fed',
          started_at: 1_785_321_800,
        },
      }),
    );
    expect(
      child.ingestLine(
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T10:43:20.300Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 5,
                output_tokens: 3,
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      sessionId: '019fab5d-b0bc-7fc1-ac78-510e35abbc48',
      messageId: expect.stringMatching(
        /^codex:v2:[a-f0-9]{64}:2:2026-07-29T10:43:20\.300Z$/,
      ),
      inputTokens: 15,
      outputTokens: 3,
    });
    expect(child.cwd).toBe('/workspace/filho');
    expect(child.threadId).toBe(
      '019fad78-bf8f-7b63-837f-750b9c02bcd3',
    );
  });

  it('usa started_at com tolerância de um segundo em builds sem UUIDv7', () => {
    const child = new CodexFileIngest();
    child.ingestLine(
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'thread-filho-legado',
          session_id: 'thread-pai-legado',
          timestamp: '2026-07-29T10:43:19.590Z',
          cwd: '/workspace',
        },
      }),
    );
    child.ingestLine(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-pai-legado',
          started_at: 1_785_321_797,
        },
      }),
    );
    expect(child.ingestLine(TOKEN_COUNT)).toBeNull();

    child.ingestLine(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-filho-legado',
          // Older builds truncate started_at to whole seconds.
          started_at: 1_785_321_799,
        },
      }),
    );
    expect(
      child.ingestLine(
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-07-29T10:43:20.300Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 5,
                output_tokens: 3,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ inputTokens: 15, outputTokens: 3 });
  });
});
