import { describe, expect, it } from 'vitest';
import { annotationsToAgentPrompt } from './agent-attach';

describe('annotationsToAgentPrompt', () => {
  it('formats annotations for the agent', () => {
    const text = annotationsToAgentPrompt([
      { path: 'src/a.ts', line: 10, body: 'fix null check' },
      { path: 'src/b.ts', line: 2, body: 'rename' },
    ]);
    expect(text).toContain('src/a.ts:10');
    expect(text).toContain('fix null check');
    expect(text).toContain('src/b.ts:2');
  });

  it('returns empty for no annotations', () => {
    expect(annotationsToAgentPrompt([])).toBe('');
  });
});
