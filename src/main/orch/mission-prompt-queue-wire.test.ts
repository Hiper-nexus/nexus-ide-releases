// @vitest-environment node
/**
 * Production wire: prepare-project and bootstrap enqueue use the real
 * registry start/complete path (not pure reduce alone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpMissionPromptIntent,
  completeMissionPrompt,
  deleteMissionPromptQueue,
  getMissionPromptAbortSignal,
  enqueueMissionPrompt,
  getMissionPromptQueue,
  peekMissionPromptQueue,
  resetMissionPromptQueues,
  startMissionPrompt,
} from './mission-prompt-queue-registry';

describe('mission prompt queue production wire', () => {
  beforeEach(() => {
    resetMissionPromptQueues();
  });

  it('enqueues bootstrap, starts, and completes (dispatch path)', () => {
    const missionId = 'm-boot';
    const enq = enqueueMissionPrompt({
      missionId,
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'boot-1',
    });
    expect(enq.state.items[0]!.status).toBe('queued');
    startMissionPrompt(missionId, 'boot-1');
    expect(peekMissionPromptQueue(missionId).executing?.id).toBe('boot-1');
    completeMissionPrompt(missionId, 'boot-1', true);
    expect(getMissionPromptQueue(missionId).items[0]!.status).toBe('delivered');
    expect(peekMissionPromptQueue(missionId).executing).toBeNull();
  });

  it('preempts in-flight bootstrap when intentVersion advances (user goal)', () => {
    const missionId = 'm-preempt';
    enqueueMissionPrompt({
      missionId,
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'old-boot',
    });
    startMissionPrompt(missionId, 'old-boot');

    const user = enqueueMissionPrompt({
      missionId,
      kind: 'user_goal',
      body: 'novo objetivo',
      intentVersion: 2,
      source: 'typed',
      id: 'goal-2',
    });

    expect(user.cancelledIds).toContain('old-boot');
    expect(
      getMissionPromptQueue(missionId).items.find((i) => i.id === 'old-boot')
        ?.status,
    ).toBe('cancelled');
    expect(peekMissionPromptQueue(missionId).queued.map((i) => i.id)).toContain(
      'goal-2',
    );
    expect(getMissionPromptAbortSignal(missionId, 'old-boot')?.aborted).toBe(true);
  });

  it('aborts an executing preflight and releases its controller on reset', () => {
    const missionId = 'm-abort';
    enqueueMissionPrompt({
      missionId, kind: 'preflight', body: 'warm orientation',
      intentVersion: 1, source: 'system', id: 'preflight-1',
    });
    startMissionPrompt(missionId, 'preflight-1');
    const signal = getMissionPromptAbortSignal(missionId, 'preflight-1');
    expect(signal?.aborted).toBe(false);
    resetMissionPromptQueues();
    expect(signal?.aborted).toBe(true);
    expect(getMissionPromptAbortSignal(missionId, 'preflight-1')).toBeUndefined();
  });

  it('preflight prepare-project path starts and completes', () => {
    const missionId = 'm-prep';
    enqueueMissionPrompt({
      missionId,
      kind: 'preflight',
      body: 'prepare-project: aquecer mapa local',
      intentVersion: 1,
      source: 'system',
      id: 'prep-1',
    });
    startMissionPrompt(missionId, 'prep-1');
    completeMissionPrompt(missionId, 'prep-1', true);
    const snap = peekMissionPromptQueue(missionId);
    expect(snap.executing).toBeNull();
    expect(
      getMissionPromptQueue(missionId).items.find((i) => i.id === 'prep-1')
        ?.status,
    ).toBe('delivered');
  });

  it('aborts and forgets mission queue state when the mission is removed', () => {
    enqueueMissionPrompt({
      missionId: 'm-removed', kind: 'preflight', body: 'warm',
      intentVersion: 1, source: 'system', id: 'remove-me',
    });
    startMissionPrompt('m-removed', 'remove-me');
    const signal = getMissionPromptAbortSignal('m-removed', 'remove-me');

    deleteMissionPromptQueue('m-removed');

    expect(signal?.aborted).toBe(true);
    expect(getMissionPromptQueue('m-removed').items).toEqual([]);
  });
});

describe('mission prompt queue executing watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.MISSION_PROMPT_EXECUTING_WATCHDOG_MS = '1000';
    resetMissionPromptQueues();
  });

  afterEach(() => {
    delete process.env.MISSION_PROMPT_EXECUTING_WATCHDOG_MS;
    resetMissionPromptQueues();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('force-completes a stuck executing slot as failed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      missionId: 'm-stuck',
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'stuck-1',
    });
    startMissionPrompt('m-stuck', 'stuck-1');
    expect(peekMissionPromptQueue('m-stuck').executing?.id).toBe('stuck-1');

    vi.advanceTimersByTime(1000);

    expect(
      getMissionPromptQueue('m-stuck').items.find((i) => i.id === 'stuck-1')
        ?.status,
    ).toBe('failed');
    expect(peekMissionPromptQueue('m-stuck').executing).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('executing watchdog'),
    );
  });

  it('does not fire after a normal complete', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      missionId: 'm-ok',
      kind: 'bootstrap',
      body: 'nexus_code_map_refresh',
      intentVersion: 1,
      source: 'system',
      id: 'ok-1',
    });
    startMissionPrompt('m-ok', 'ok-1');
    completeMissionPrompt('m-ok', 'ok-1', true);

    vi.advanceTimersByTime(10_000);

    expect(
      getMissionPromptQueue('m-ok').items.find((i) => i.id === 'ok-1')?.status,
    ).toBe('delivered');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clears the watchdog when an executing item is preempted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueMissionPrompt({
      missionId: 'm-preempted',
      kind: 'bootstrap',
      body: 'nexus_context_doctor',
      intentVersion: 1,
      source: 'system',
      id: 'preempted-1',
    });
    startMissionPrompt('m-preempted', 'preempted-1');
    bumpMissionPromptIntent('m-preempted', 2);
    expect(
      getMissionPromptQueue('m-preempted').items.find(
        (i) => i.id === 'preempted-1',
      )?.status,
    ).toBe('cancelled');

    vi.advanceTimersByTime(10_000);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
