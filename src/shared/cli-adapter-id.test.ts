import { describe, expect, it } from 'vitest';
import { canonicalCliAdapterId } from './cli-adapter-id';

describe('canonicalCliAdapterId', () => {
  it('migra Gemini CLI e aliases Antigravity para AGY', () => {
    expect(canonicalCliAdapterId('gemini')).toBe('agy');
    expect(canonicalCliAdapterId('gemini-cli')).toBe('agy');
    expect(canonicalCliAdapterId('antigravity-cli')).toBe('agy');
    expect(canonicalCliAdapterId('agy')).toBe('agy');
  });
});
