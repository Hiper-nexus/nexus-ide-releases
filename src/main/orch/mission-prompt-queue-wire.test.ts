// @vitest-environment node
/**
 * Production wire: prepare-project and bootstrap enqueue use the real
 * registry start/complete path (not pure reduce alone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpMissionPromptIntent,
  cancelMissionPrompt,
  completeMissionPrompt,
  deleteMissionPromptQueue,
  getMissionPromptAbortSignal,
  enqueueMissionPrompt,
  getMissionPromptQueue,
  peekMissionPromptQueue,
  resetMissionPromptQueues,
  startMissionPrompt,
} from './mission-prompt-queue-registry';
import { testProjectScope } from './__tests__/scope-fixture';

const scopeA = testProjectScope({
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
});
const scopeB = testProjectScope({
  installationId: 'installation-b',
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});

describe('mission prompt queue production wire', () => {
  beforeEach(() => {
    resetMissionPromptQueues();
  });

  it('enqueues bootstrap, starts, and completes (dispatch path)', () => {
    const missionId = 'm-boot';
    const enq = enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'boot-1',
    });
    expect(enq.state.items[0]!.status).toBe('queued');
    startMissionPrompt(scopeA, missionId, 'boot-1');
    expect(peekMissionPromptQueue(scopeA, missionId).executing?.id).toBe('boot-1');
    completeMissionPrompt(scopeA, missionId, 'boot-1', true);
    expect(getMissionPromptQueue(scopeA, missionId).items[0]!.status).toBe('delivered');
    expect(peekMissionPromptQueue(scopeA, missionId).executing).toBeNull();
  });

  it('preempts in-flight bootstrap when intentVersion advances (user goal)', () => {
    const missionId = 'm-preempt';
    enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'old-boot',
    });
    startMissionPrompt(scopeA, missionId, 'old-boot');

    const user = enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'user_goal',
      body: 'novo objetivo',
      intentVersion: 2,
      source: 'typed',
      id: 'goal-2',
    });

    expect(user.cancelledIds).toContain('old-boot');
    expect(
      getMissionPromptQueue(scopeA, missionId).items.find((i) => i.id === 'old-boot')
        ?.status,
    ).toBe('cancelled');
    expect(peekMissionPromptQueue(scopeA, missionId).queued.map((i) => i.id)).toContain(
      'goal-2',
    );
    expect(getMissionPromptAbortSignal(scopeA, missionId, 'old-boot')?.aborted).toBe(true);
  });

  it('aborts an executing preflight and releases its controller on reset', () => {
    const missionId = 'm-abort';
    enqueueMissionPrompt({
      scope: scopeA,
      missionId, kind: 'preflight', body: 'warm orientation',
      intentVersion: 1, source: 'system', id: 'preflight-1',
    });
    startMissionPrompt(scopeA, missionId, 'preflight-1');
    const signal = getMissionPromptAbortSignal(scopeA, missionId, 'preflight-1');
    expect(signal?.aborted).toBe(false);
    resetMissionPromptQueues();
    expect(signal?.aborted).toBe(true);
    expect(getMissionPromptAbortSignal(scopeA, missionId, 'preflight-1')).toBeUndefined();
  });

  it('preflight prepare-project path starts and completes', () => {
    const missionId = 'm-prep';
    enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'preflight',
      body: 'prepare-project: aquecer mapa local',
      intentVersion: 1,
      source: 'system',
      id: 'prep-1',
    });
    startMissionPrompt(scopeA, missionId, 'prep-1');
    completeMissionPrompt(scopeA, missionId, 'prep-1', true);
    const snap = peekMissionPromptQueue(scopeA, missionId);
    expect(snap.executing).toBeNull();
    expect(
      getMissionPromptQueue(scopeA, missionId).items.find((i) => i.id === 'prep-1')
        ?.status,
    ).toBe('delivered');
  });

  it('aborts and forgets mission queue state when the mission is removed', () => {
    enqueueMissionPrompt({
      scope: scopeA,
      missionId: 'm-removed', kind: 'preflight', body: 'warm',
      intentVersion: 1, source: 'system', id: 'remove-me',
    });
    startMissionPrompt(scopeA, 'm-removed', 'remove-me');
    const signal = getMissionPromptAbortSignal(scopeA, 'm-removed', 'remove-me');

    deleteMissionPromptQueue(scopeA, 'm-removed');

    expect(signal?.aborted).toBe(true);
    expect(getMissionPromptQueue(scopeA, 'm-removed').items).toEqual([]);
  });

  it('isolates read, cancellation, and preemption for equal mission ids in two scopes', () => {
    const missionId = 'same-mission-id';
    enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'bootstrap',
      body: 'scope-a-bootstrap',
      intentVersion: 1,
      source: 'system',
      id: 'scope-a-prompt',
    });
    enqueueMissionPrompt({
      scope: scopeB,
      missionId,
      kind: 'bootstrap',
      body: 'scope-b-bootstrap',
      intentVersion: 1,
      source: 'system',
      id: 'scope-b-prompt',
    });
    startMissionPrompt(scopeA, missionId, 'scope-a-prompt');
    startMissionPrompt(scopeB, missionId, 'scope-b-prompt');
    const signalA = getMissionPromptAbortSignal(
      scopeA,
      missionId,
      'scope-a-prompt',
    );
    const signalB = getMissionPromptAbortSignal(
      scopeB,
      missionId,
      'scope-b-prompt',
    );

    expect(peekMissionPromptQueue(scopeA, missionId).executing?.body).toBe(
      'scope-a-bootstrap',
    );
    expect(peekMissionPromptQueue(scopeB, missionId).executing?.body).toBe(
      'scope-b-bootstrap',
    );

    cancelMissionPrompt(scopeA, missionId, 'scope-a-prompt');
    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);
    expect(peekMissionPromptQueue(scopeA, missionId).cancelled).toHaveLength(1);
    expect(peekMissionPromptQueue(scopeB, missionId).cancelled).toHaveLength(0);

    enqueueMissionPrompt({
      scope: scopeA,
      missionId,
      kind: 'preflight',
      body: 'scope-a-preemptible',
      intentVersion: 1,
      source: 'system',
      id: 'scope-a-preemptible',
    });
    startMissionPrompt(scopeA, missionId, 'scope-a-preemptible');
    const preemptedSignalA = getMissionPromptAbortSignal(
      scopeA,
      missionId,
      'scope-a-preemptible',
    );
    bumpMissionPromptIntent(scopeA, missionId, 2);
    expect(preemptedSignalA?.aborted).toBe(true);
    expect(
      getMissionPromptQueue(scopeA, missionId).items.find(
        (item) => item.id === 'scope-a-preemptible',
      )?.status,
    ).toBe('cancelled');
    expect(peekMissionPromptQueue(scopeB, missionId).executing?.id).toBe(
      'scope-b-prompt',
    );
    expect(signalB?.aborted).toBe(false);

    deleteMissionPromptQueue(scopeA, missionId);
    expect(getMissionPromptQueue(scopeA, missionId).items).toEqual([]);
    expect(peekMissionPromptQueue(scopeB, missionId).executing?.id).toBe(
      'scope-b-prompt',
    );
  });
});

describe('mission prompt queue executing watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('MISSION_PROMPT_EXECUTING_WATCHDOG_MS', '1000');
    resetMissionPromptQueues();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMissionPromptQueues();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('force-completes a stuck executing slot as failed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      scope: scopeA,
      missionId: 'm-stuck',
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'stuck-1',
    });
    startMissionPrompt(scopeA, 'm-stuck', 'stuck-1');
    expect(peekMissionPromptQueue(scopeA, 'm-stuck').executing?.id).toBe('stuck-1');

    vi.advanceTimersByTime(1000);

    expect(
      getMissionPromptQueue(scopeA, 'm-stuck').items.find((i) => i.id === 'stuck-1')
        ?.status,
    ).toBe('failed');
    expect(peekMissionPromptQueue(scopeA, 'm-stuck').executing).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('executing watchdog'),
    );
  });

  it('does not fire after a normal complete', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      scope: scopeA,
      missionId: 'm-ok',
      kind: 'bootstrap',
      body: 'nexus_code_map_refresh',
      intentVersion: 1,
      source: 'system',
      id: 'ok-1',
    });
    startMissionPrompt(scopeA, 'm-ok', 'ok-1');
    completeMissionPrompt(scopeA, 'm-ok', 'ok-1', true);

    vi.advanceTimersByTime(10_000);

    expect(
      getMissionPromptQueue(scopeA, 'm-ok').items.find((i) => i.id === 'ok-1')?.status,
    ).toBe('delivered');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clears the watchdog when an executing item is preempted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      scope: scopeA,
      missionId: 'm-preempted',
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'preempted-1',
    });
    startMissionPrompt(scopeA, 'm-preempted', 'preempted-1');
    bumpMissionPromptIntent(scopeA, 'm-preempted', 2);
    expect(
      getMissionPromptQueue(scopeA, 'm-preempted').items.find(
        (i) => i.id === 'preempted-1',
      )?.status,
    ).toBe('cancelled');

    vi.advanceTimersByTime(10_000);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
