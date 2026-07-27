import { describe, expect, it } from 'vitest';
import { isModelId, MODEL_ID_PATTERN, normalizeModelId } from './model-id';

describe('model-id schema', () => {
  it('accepts real provider model IDs', () => {
    for (const id of [
      'claude-opus-4.1',
      'gpt-5.2-codex',
      'openai/gpt-5',
      'accounts/fireworks/models/kimi-k2-instruct',
      'gemini-2.5-pro',
      'kimi-k2:free',
      'a',
    ]) {
      expect(isModelId(id), id).toBe(true);
    }
  });

  it('rejects empties, leading separators, whitespace, and overlong IDs', () => {
    for (const id of [
      '',
      ' ',
      '-abc',
      '/abc',
      ':abc',
      'model id',
      'a'.repeat(129),
    ]) {
      expect(isModelId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('normalizes strings and rejects non-string candidates', () => {
    expect(normalizeModelId('  gpt-5 ')).toBe('gpt-5');
    expect(normalizeModelId(42)).toBeNull();
    expect(normalizeModelId(null)).toBeNull();
    expect(normalizeModelId(' --bad')).toBeNull();
  });

  it('keeps the canonical pattern stable across discovery adapters', () => {
    expect(MODEL_ID_PATTERN.source).toBe(
      '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$',
    );
  });
});
