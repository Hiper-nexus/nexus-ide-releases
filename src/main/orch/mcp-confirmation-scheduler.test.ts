import { describe, expect, it, vi } from 'vitest';
import type { McpConfirmationRequest } from './mcp-dispatch';
import { McpConfirmationScheduler } from './mcp-confirmation-scheduler';

function request(sessionId: string, toolName: string): McpConfirmationRequest {
  return {
    source: 'http-mcp',
    sessionId,
    workspaceId: '/repo',
    projectId: 'project',
    checkoutId: 'checkout',
    missionId: 'mission',
    contextRevision: 'c'.repeat(64),
    toolName,
    args: {},
    reason: 'requires explicit confirmation',
    agentLabel: `agent-${sessionId}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MCP confirmation scheduler', () => {
  it('keeps one dialog active and serves per-session queues round-robin', async () => {
    const gates = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const shown: string[] = [];
    const show = vi.fn((entry: McpConfirmationRequest) => {
      shown.push(entry.toolName);
      return gates[shown.length - 1]!.promise;
    });
    const scheduler = new McpConfirmationScheduler(show, {
      maxRequestsPerWindow: 10,
    });

    const a1 = scheduler.enqueue(request('session-a', 'a-1'));
    const a2 = scheduler.enqueue(request('session-a', 'a-2'));
    const b1 = scheduler.enqueue(request('session-b', 'b-1'));
    await Promise.resolve();
    expect(shown).toEqual(['a-1']);

    gates[0].resolve(true);
    await a1;
    await Promise.resolve();
    expect(shown).toEqual(['a-1', 'b-1']);

    gates[1].resolve(false);
    await b1;
    await Promise.resolve();
    expect(shown).toEqual(['a-1', 'b-1', 'a-2']);

    gates[2].resolve(true);
    await expect(a2).resolves.toBe(true);
  });

  it('fails closed when one agent exceeds its bounded outstanding queue', async () => {
    const gate = deferred<boolean>();
    const scheduler = new McpConfirmationScheduler(() => gate.promise, {
      maxOutstandingPerSession: 2,
      maxRequestsPerWindow: 10,
    });

    const first = scheduler.enqueue(request('session-a', 'a-1'));
    const second = scheduler.enqueue(request('session-a', 'a-2'));
    await expect(
      scheduler.enqueue(request('session-a', 'a-3')),
    ).rejects.toThrow(/confirmation_queue_full/);

    gate.resolve(false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it('rate-limits each session independently and reopens after the window', async () => {
    let now = 10_000;
    const show = vi.fn(async () => true);
    const scheduler = new McpConfirmationScheduler(show, {
      maxRequestsPerWindow: 2,
      rateWindowMs: 1_000,
      now: () => now,
    });

    await expect(scheduler.enqueue(request('session-a', 'a-1'))).resolves.toBe(true);
    await expect(scheduler.enqueue(request('session-a', 'a-2'))).resolves.toBe(true);
    await expect(
      scheduler.enqueue(request('session-a', 'a-3')),
    ).rejects.toThrow(/confirmation_rate_limited/);
    await expect(scheduler.enqueue(request('session-b', 'b-1'))).resolves.toBe(true);

    now += 1_001;
    await expect(scheduler.enqueue(request('session-a', 'a-4'))).resolves.toBe(true);
    expect(show).toHaveBeenCalledTimes(4);
  });

  it('rejects queued work on shutdown instead of leaking confirmations', async () => {
    const gate = deferred<boolean>();
    const scheduler = new McpConfirmationScheduler(() => gate.promise, {
      maxRequestsPerWindow: 10,
    });
    const active = scheduler.enqueue(request('session-a', 'a-1'));
    const queued = scheduler.enqueue(request('session-b', 'b-1'));
    await Promise.resolve();

    scheduler.close();
    await expect(queued).rejects.toThrow(/confirmation_scheduler_closed/);
    gate.resolve(false);
    await expect(active).resolves.toBe(false);
  });
});
