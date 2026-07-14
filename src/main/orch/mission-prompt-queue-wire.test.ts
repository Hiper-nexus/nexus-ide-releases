// @vitest-environment node
/**
 * Production wire: prepare-project and bootstrap enqueue use the real
 * registry start/complete path (not pure reduce alone).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeMissionPrompt,
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
});
