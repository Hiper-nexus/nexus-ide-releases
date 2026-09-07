import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

const harness = vi.hoisted(() => ({
  agentInfo: new Map<string, Record<string, unknown>>(),
  sessionState: new Map<string, string>(),
  paneSessions: new Map<string, string[]>(),
  exitTaps: new Set<(sessionId: string, agent: unknown) => void>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (sessionId: string) =>
    harness.agentInfo.get(sessionId) ?? null,
  getSessionState: (sessionId: string) =>
    harness.sessionState.get(sessionId) ?? null,
  listAgentSessionsForPane: (paneId: string) =>
    (harness.paneSessions.get(paneId) ?? [])
      .map((sessionId) => harness.agentInfo.get(sessionId))
      .filter((info) => info !== undefined),
  tapSessionExit: (cb: (sessionId: string, agent: unknown) => void) => {
    harness.exitTaps.add(cb);
    return () => harness.exitTaps.delete(cb);
  },
  publishSessionActivityState: () => true,
}));

import {
  __resetAgentStatusForTests,
  applyCanonicalHookEvent,
  resetAgentStatusOnExit,
} from './agent-status';
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  promptAgentAndWait,
  SemanticWaitError,
  waitForSemanticStatus,
} from './semantic-wait';

const userSubmit: CanonicalHookEvent = {
  kind: 'status',
  type: 'start',
  clearsAwaitingInput: true,
  promptSubmitted: true,
};
const stop: CanonicalHookEvent = { kind: 'status', type: 'stop' };
const failure: CanonicalHookEvent = { kind: 'status', type: 'error' };
const permission: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'permission_prompt',
  message: 'Claude needs your permission to run Bash',
};
const idlePrompt: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'idle_prompt',
};

function seatAgent(
  sessionId: string,
  paneId: string,
  agentName = 'executor',
): void {
  harness.agentInfo.set(sessionId, {
    sessionId,
    paneId,
    agentName,
    adapterId: 'claude',
  });
  harness.sessionState.set(sessionId, 'idle');
  harness.paneSessions.set(paneId, [
    ...(harness.paneSessions.get(paneId) ?? []),
    sessionId,
  ]);
}

/** pty-manager deletes the session BEFORE firing exit taps — mirror that. */
function fireSessionExit(sessionId: string): void {
  harness.agentInfo.delete(sessionId);
  harness.sessionState.delete(sessionId);
  for (const tap of [...harness.exitTaps]) tap(sessionId, null);
}

beforeEach(() => {
  __resetAgentStatusForTests();
  harness.agentInfo.clear();
  harness.sessionState.clear();
  harness.paneSessions.clear();
  harness.exitTaps.clear();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForSemanticStatus', () => {
  it('resolves from the initial snapshot when the status already matches', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });

    await expect(
      waitForSemanticStatus({ sessionId: 'pty-1' }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      status: 'completed',
      sessionId: 'pty-1',
      paneId: 'pane-1',
      agentName: 'executor',
    });
  });

  it.each([
    ['working', userSubmit, ['working']],
    ['completed', stop, ['completed']],
    ['awaiting-input', permission, ['awaiting-input']],
    ['idle', idlePrompt, ['idle']],
    ['error', failure, ['error']],
  ] as const)('resolves on a later transition to %s', async (status, event, until) => {
    seatAgent('pty-1', 'pane-1');

    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { until, timeoutMs: 5_000 },
    );
    applyCanonicalHookEvent({ sessionId: 'pty-1', event });

    await expect(promise).resolves.toMatchObject({ status });
  });

  it('uses the default until set (idle | completed | awaiting-input)', async () => {
    seatAgent('pty-1', 'pane-1');
    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { timeoutMs: 5_000 },
    );
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    await expect(promise).resolves.toMatchObject({ status: 'awaiting-input' });
  });

  it('rejects agent_not_running when the session exits mid-wait', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { until: ['completed'], timeoutMs: 5_000 },
    );
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'agent_not_running',
    });
    fireSessionExit('pty-1');
    // The reset-on-exit idle entry must not resurrect the wait afterwards.
    resetAgentStatusOnExit('pty-1');
    await assertion;
  });

  it('never lets a substitute process in the same pane satisfy the wait', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { until: ['completed'], timeoutMs: 1_000 },
    );
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'timeout',
    });
    // Respawn: a NEW session id now occupies the pane and completes — the
    // pinned wait must not see it.
    seatAgent('pty-2', 'pane-1', 'executor');
    applyCanonicalHookEvent({ sessionId: 'pty-2', event: stop });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('rejects agent_not_running when the occupant agent identity changes', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { until: ['completed'], timeoutMs: 5_000 },
    );
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'agent_not_running',
    });
    // Same session id, different agent: the pin must fail on the next probe.
    harness.agentInfo.set('pty-1', {
      sessionId: 'pty-1',
      paneId: 'pane-1',
      agentName: 'impostor',
      adapterId: 'claude',
    });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    await assertion;
  });

  it('rejects timeout after probing the current status one last time', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    const promise = waitForSemanticStatus(
      { sessionId: 'pty-1' },
      { until: ['completed'], timeoutMs: 1_000 },
    );
    const assertion = expect(promise).rejects.toSatisfy(
      (error) =>
        error instanceof SemanticWaitError &&
        error.code === 'timeout' &&
        error.message.includes('working'),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('resolves paneId targets through the pane session inventory', async () => {
    seatAgent('pty-1', 'pane-1');

    const promise = waitForSemanticStatus(
      { paneId: 'pane-1' },
      { until: ['working'], timeoutMs: 5_000 },
    );
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    await expect(promise).resolves.toMatchObject({
      status: 'working',
      sessionId: 'pty-1',
    });
  });

  it('rejects agent_not_running for a pane with no managed agent', async () => {
    await expect(
      waitForSemanticStatus({ paneId: 'pane-9' }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'agent_not_running' });
  });

  it('rejects invalid_until for unknown statuses', async () => {
    seatAgent('pty-1', 'pane-1');
    await expect(
      waitForSemanticStatus(
        { sessionId: 'pty-1' },
        { until: ['nope'], timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_until' });
  });
});

describe('promptAgentAndWait', () => {
  it('fails agent_blocked without writing when the agent awaits input', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    const write = vi.fn(async () => {});

    await expect(
      promptAgentAndWait({ sessionId: 'pty-1', text: 'go', write }),
    ).rejects.toMatchObject({ code: 'agent_blocked' });
    expect(write).not.toHaveBeenCalled();
  });

  it('loses no fast transition between submission and wait registration', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: idlePrompt });
    vi.advanceTimersByTime(10);
    // The whole turn happens INSIDE the write call (before the final wait is
    // awaited): the taps armed pre-write must still observe it.
    const write = vi.fn(async (sessionId: string) => {
      applyCanonicalHookEvent({ sessionId, event: userSubmit });
      applyCanonicalHookEvent({ sessionId, event: stop });
    });

    const result = await promptAgentAndWait({
      sessionId: 'pty-1',
      text: 'go',
      write,
      wait: { timeoutMs: 10_000 },
    });

    expect(write).toHaveBeenCalledWith('pty-1', 'go');
    expect(result).toMatchObject({
      submitted: true,
      sessionId: 'pty-1',
      paneId: 'pane-1',
      agentName: 'executor',
      turnSequenceBefore: 0,
      activity: { kind: 'turn-start', status: 'completed' },
      match: { status: 'completed' },
    });
  });

  it('rejects agent_prompt_stalled when the prompt shows no effect in 5s', async () => {
    seatAgent('pty-1', 'pane-1');
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: idlePrompt });
    vi.advanceTimersByTime(10);
    const write = vi.fn(async () => {});

    const promise = promptAgentAndWait({
      sessionId: 'pty-1',
      text: 'go',
      write,
      wait: { timeoutMs: 30_000 },
    });
    const assertion = expect(promise).rejects.toSatisfy(
      (error) =>
        error instanceof SemanticWaitError &&
        error.code === 'agent_prompt_stalled' &&
        error.message.includes('idle'),
    );
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS);
    await assertion;
    // The stale pre-prompt idle must never satisfy the final wait: the call
    // died at the activity gate, before any match.
  });

  it('rejects agent_not_running when the session exits during the final wait', async () => {
    seatAgent('pty-1', 'pane-1');
    const write = vi.fn(async (sessionId: string) => {
      applyCanonicalHookEvent({ sessionId, event: userSubmit });
    });

    const promise = promptAgentAndWait({
      sessionId: 'pty-1',
      text: 'go',
      write,
      wait: { until: ['completed'], timeoutMs: 30_000 },
    });
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'agent_not_running',
    });
    await vi.advanceTimersByTimeAsync(0);
    fireSessionExit('pty-1');
    await assertion;
  });

  it('confirms submission only (fire-and-forget) without wait', async () => {
    seatAgent('pty-1', 'pane-1');
    const write = vi.fn(async () => {});

    const result = await promptAgentAndWait({
      sessionId: 'pty-1',
      text: 'go',
      write,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(true);
    expect(result.match).toBeUndefined();
    expect(result.activity).toBeUndefined();
  });

  it('rejects agent_not_running when the target is not a managed agent', async () => {
    const write = vi.fn(async () => {});
    await expect(
      promptAgentAndWait({ sessionId: 'pty-gone', text: 'go', write }),
    ).rejects.toMatchObject({ code: 'agent_not_running' });
    expect(write).not.toHaveBeenCalled();
  });
});
