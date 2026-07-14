import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

import { resetAgentLifecycleForTests } from './agent-lifecycle';
import {
  AGENT_LIFECYCLE_CHANNELS,
  agentLifecycleList,
  agentLifecycleRecord,
  agentLifecycleReap,
  resetAgentLifecycleServiceForTests,
  startAgentLifecycleService,
  stopAgentLifecycleService,
} from './agent-lifecycle-service';

afterEach(() => {
  resetAgentLifecycleServiceForTests();
  resetAgentLifecycleForTests();
  handlers.clear();
});

describe('agent lifecycle product entry', () => {
  it('records via service API and reaps finished only (never running)', () => {
    startAgentLifecycleService({ reapIntervalMs: 60_000 });

    agentLifecycleRecord({
      sessionId: 'run-1',
      status: 'running',
      at: 1_000,
    });
    agentLifecycleRecord({
      sessionId: 'done-1',
      status: 'finished',
      at: 1_000,
      transcriptPath: '/Users/me/.secret/session.jsonl',
    });

    const listed = agentLifecycleList();
    expect(listed.find((a) => a.sessionId === 'done-1')?.transcriptPath).toBe(
      '[transcript]/session.jsonl',
    );

    // Too young to reap
    expect(agentLifecycleReap(1_500, 60_000)).toEqual([]);
    // Age past maxAge
    const reaped = agentLifecycleReap(100_000, 1_000);
    expect(reaped).toEqual(['done-1']);
    expect(reaped).not.toContain('run-1');
    expect(agentLifecycleList().find((a) => a.sessionId === 'run-1')?.status).toBe(
      'running',
    );
    expect(agentLifecycleList().find((a) => a.sessionId === 'done-1')?.status).toBe(
      'reaped',
    );
  });

  it('registers IPC handlers that drive the same record/list/reap path', async () => {
    startAgentLifecycleService({ reapIntervalMs: 60_000 });
    expect(handlers.has(AGENT_LIFECYCLE_CHANNELS.record)).toBe(true);
    expect(handlers.has(AGENT_LIFECYCLE_CHANNELS.list)).toBe(true);
    expect(handlers.has(AGENT_LIFECYCLE_CHANNELS.reap)).toBe(true);

    const record = handlers.get(AGENT_LIFECYCLE_CHANNELS.record)!;
    const list = handlers.get(AGENT_LIFECYCLE_CHANNELS.list)!;
    const reap = handlers.get(AGENT_LIFECYCLE_CHANNELS.reap)!;

    record({}, {
      sessionId: 'ipc-done',
      status: 'finished',
      at: 10,
    });
    const agents = list({}) as Array<{ sessionId: string; status: string }>;
    expect(agents.some((a) => a.sessionId === 'ipc-done')).toBe(true);

    const reaped = reap({}) as string[];
    // maxAge default 60s; at=10 with Date.now() will be old enough
    expect(reaped).toContain('ipc-done');
  });

  it('stop clears the reap timer without throwing', () => {
    startAgentLifecycleService({ reapIntervalMs: 10_000 });
    stopAgentLifecycleService();
    stopAgentLifecycleService(); // idempotent
  });
});
