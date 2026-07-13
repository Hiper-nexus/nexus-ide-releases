import { describe, expect, it } from 'vitest';
import { parseOpenCodeAuthJson } from './opencode-auth';

describe('parseOpenCodeAuthJson', () => {
  it('extracts string and object key forms', () => {
    const entries = parseOpenCodeAuthJson(
      JSON.stringify({
        anthropic: { type: 'api', key: 'sk-ant-api03-a' },
        openai: { apiKey: 'sk-openai-b' },
        zai: 'hexkeyhexkeyhexkeyhexkeyhexkey12',
        empty: {},
      }),
    );
    expect(entries.map((e) => e.providerId).sort()).toEqual([
      'anthropic',
      'openai',
      'zai',
    ]);
    expect(entries.find((e) => e.providerId === 'openai')?.key).toBe(
      'sk-openai-b',
    );
  });

  it('dedupes identical keys', () => {
    const entries = parseOpenCodeAuthJson(
      JSON.stringify({
        a: { key: 'same-key-value-12345678' },
        b: { apiKey: 'same-key-value-12345678' },
      }),
    );
    expect(entries).toHaveLength(1);
  });
});
