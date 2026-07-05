import { describe, expect, it } from 'vitest';
import {
  claudeProjectSlug,
  parseTranscriptLine,
  splitTailChunk,
} from './claude-transcript';

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  sessionId: 'sess-123',
  timestamp: '2026-07-05T12:00:00.000Z',
  message: {
    id: 'msg_abc',
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 100,
      },
    },
  },
});

describe('claudeProjectSlug', () => {
  it('converte caminho absoluto no slug do Claude Code', () => {
    expect(claudeProjectSlug('/Users/x/nexus-ide')).toBe('-Users-x-nexus-ide');
  });
});

describe('parseTranscriptLine', () => {
  it('extrai uso real de um turno de assistant', () => {
    const ev = parseTranscriptLine(ASSISTANT_LINE);
    expect(ev).not.toBeNull();
    expect(ev).toMatchObject({
      sessionId: 'sess-123',
      messageId: 'msg_abc',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWrite5mTokens: 200,
      cacheWrite1hTokens: 100,
    });
    expect(ev?.timestamp).toBe(Date.parse('2026-07-05T12:00:00.000Z'));
  });

  it('usa o agregado legado quando não há split 5m/1h', () => {
    const line = JSON.parse(ASSISTANT_LINE);
    delete line.message.usage.cache_creation;
    const ev = parseTranscriptLine(JSON.stringify(line));
    expect(ev?.cacheWrite5mTokens).toBe(300);
    expect(ev?.cacheWrite1hTokens).toBe(0);
  });

  it('ignora linhas de user/meta/lixo sem lançar', () => {
    expect(parseTranscriptLine('{"type":"user","message":{}}')).toBeNull();
    expect(parseTranscriptLine('não é json')).toBeNull();
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('{"type":"assistant"}')).toBeNull();
  });

  it('ignora assistant sem sessionId (não atribuível)', () => {
    const line = JSON.parse(ASSISTANT_LINE);
    delete line.sessionId;
    expect(parseTranscriptLine(JSON.stringify(line))).toBeNull();
  });

  it('trata contagens ausentes/negativas como zero', () => {
    const line = JSON.parse(ASSISTANT_LINE);
    line.message.usage = { input_tokens: -5 };
    const ev = parseTranscriptLine(JSON.stringify(line));
    expect(ev).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });
});

describe('splitTailChunk', () => {
  it('junta remainder anterior e segura a linha parcial final', () => {
    const first = splitTailChunk('', '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.remainder).toBe('{"b":');
    const second = splitTailChunk(first.remainder, '2}\n');
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.remainder).toBe('');
  });

  it('descarta linhas vazias', () => {
    expect(splitTailChunk('', '\n\n{"a":1}\n\n').lines).toEqual(['{"a":1}']);
  });
});
