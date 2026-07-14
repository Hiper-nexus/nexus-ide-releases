import { describe, expect, it } from 'vitest';
import {
  assertExplicitAccountSwitch,
  listAgents,
  reapFinishedAgents,
  recordAgentEvent,
  redactTranscriptPath,
  resetAgentLifecycleForTests,
} from './agent-lifecycle';

describe('agent lifecycle', () => {
  it('reaps finished only and redacts transcript paths', () => {
    resetAgentLifecycleForTests();
    recordAgentEvent({
      sessionId: 's-run',
      status: 'running',
      at: 1,
    });
    recordAgentEvent({
      sessionId: 's-done',
      status: 'finished',
      at: 1,
      transcriptPath: '/Users/me/.claude/projects/secret/session.jsonl',
    });
    const rec = listAgents().find((a) => a.sessionId === 's-done');
    expect(rec?.transcriptPath).toBe('[transcript]/session.jsonl');
    expect(redactTranscriptPath('/a/b/c.jsonl')).toBe('[transcript]/c.jsonl');

    const reaped = reapFinishedAgents(100_000, 1_000);
    expect(reaped).toContain('s-done');
    expect(reaped).not.toContain('s-run');
    expect(listAgents().find((a) => a.sessionId === 's-run')?.status).toBe(
      'running',
    );
  });

  it('requires explicit account switch target', () => {
    expect(() => assertExplicitAccountSwitch('a', '')).toThrow();
    expect(() => assertExplicitAccountSwitch(undefined, 'b')).not.toThrow();
  });
});
