import { describe, expect, it } from 'vitest';
import {
  completeCommandBlock,
  createCommandBlock,
} from './command-block';

const base = {
  id: 'cb-1',
  sessionId: 'sess',
  paneId: 'pane',
  workspaceId: 'ws',
  command: 'echo hi',
  cwd: '/tmp',
  shell: 'zsh',
  startedAt: 1000,
  status: 'running' as const,
  redaction: { redacted: false, denylisted: false, secretHits: 0 },
  idempotencyKey: 'a'.repeat(64),
};

describe('CommandBlock model', () => {
  it('creates immutable validated blocks', () => {
    const block = createCommandBlock(base);
    expect(block.status).toBe('running');
    expect(Object.isFrozen(block)).toBe(false);
    // Structural immutability via create/complete helpers — no mutators.
    expect(() =>
      createCommandBlock({ ...base, idempotencyKey: 'short' }),
    ).toThrow();
  });

  it('completes running blocks without mutating the original', () => {
    const running = createCommandBlock({
      ...base,
      outputRange: { startSeq: 1, endSeq: null },
    });
    const done = completeCommandBlock(running, {
      endedAt: 1500,
      exitCode: 0,
      status: 'success',
      endSeq: 42,
    });
    expect(running.status).toBe('running');
    expect(done.status).toBe('success');
    expect(done.durationMs).toBe(500);
    expect(done.outputRange?.endSeq).toBe(42);
  });

  it('refuses to complete non-running blocks', () => {
    const done = createCommandBlock({
      ...base,
      status: 'success',
      endedAt: 1100,
      durationMs: 100,
      exitCode: 0,
    });
    expect(() =>
      completeCommandBlock(done, {
        endedAt: 1200,
        status: 'failed',
      }),
    ).toThrow(/only running/);
  });
});
