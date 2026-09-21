import { describe, expect, it } from 'vitest';
import { parseMimoUsageRow } from './mimo-transcript';

const message = {
  role: 'assistant', modelID: 'mimo-v2.6-pro', providerID: 'xiaomi',
  path: { cwd: '/project', root: '/project' }, time: { created: 100, completed: 200 },
  cost: 0.0042, tokens: { input: 10, output: 20, reasoning: 7, cache: { read: 30, write: 2 } },
};
const row = (data: unknown) => ({ id: 'msg_1', session_id: 'ses_1', data: JSON.stringify(data) });

describe('MiMo official usage parser', () => {
  it('preserves provider cost, adds reasoning once, and keeps cached input separate', () => {
    expect(parseMimoUsageRow(row(message))).toEqual({
      event: {
        sessionId: 'ses_1', messageId: 'msg_1', model: 'xiaomi/mimo-v2.6-pro',
        inputTokens: 10, outputTokens: 27, cacheReadTokens: 30,
        cacheWrite5mTokens: 2, cacheWrite1hTokens: 0, timestamp: 100,
        reportedCostUsd: 0.0042,
      },
      cwd: '/project',
    });
  });

  it.each([
    { ...message, role: 'user' },
    { ...message, cost: -1 },
    { ...message, tokens: { ...message.tokens, output: -1 } },
    { ...message, tokens: { ...message.tokens, reasoning: Number.MAX_SAFE_INTEGER } },
    { ...message, tokens: undefined },
  ])('rejects malformed or non-assistant usage', value => {
    expect(parseMimoUsageRow(row(value))).toBeNull();
  });

  it('never emits prompt, answer, key, or arbitrary provider metadata', () => {
    const parsed = parseMimoUsageRow(row({ ...message, text: 'private answer', key: 'private-key' }));
    expect(JSON.stringify(parsed)).not.toMatch(/private answer|private-key/);
    expect(parseMimoUsageRow({ id: 'msg', session_id: 'ses', data: '{' })).toBeNull();
  });
});
