import { describe, expect, it } from 'vitest';
import { CodexFileIngest, parseCodexLine } from './codex-transcript';

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
      meta: { sessionId: 'codex-sess-1', cwd: '/Users/x/nexus-ide' },
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
    expect(a.ingestLine(TOKEN_COUNT)?.messageId).toBe(
      b.ingestLine(TOKEN_COUNT)?.messageId,
    );
  });
});
