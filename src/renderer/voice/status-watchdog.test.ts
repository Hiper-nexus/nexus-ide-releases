import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATUS_STUCK_DEADLINES_MS,
  statusWatchdogAction,
  speakingHasAudioProgress,
} from './status-watchdog';

describe('statusWatchdogAction', () => {
  it('never fires for idle/listening/error (owned elsewhere)', () => {
    expect(statusWatchdogAction('idle', 999_999)).toBe('none');
    expect(statusWatchdogAction('listening', 999_999)).toBe('none');
    expect(statusWatchdogAction('error', 999_999)).toBe('none');
  });

  it('fires force-idle when transcribing exceeds its deadline (> STT 60s)', () => {
    const deadline = STATUS_STUCK_DEADLINES_MS.transcribing!;
    expect(statusWatchdogAction('transcribing', deadline - 1)).toBe('none');
    expect(statusWatchdogAction('transcribing', deadline)).toBe('force-idle');
  });

  it('fires for routing and speaking past their deadlines', () => {
    expect(
      statusWatchdogAction('routing', STATUS_STUCK_DEADLINES_MS.routing!),
    ).toBe('force-idle');
    expect(
      statusWatchdogAction('speaking', STATUS_STUCK_DEADLINES_MS.speaking!),
    ).toBe('force-idle');
  });

  it('all deadlines exceed the stage deadlines they guard', () => {
    expect(STATUS_STUCK_DEADLINES_MS.transcribing!).toBeGreaterThan(60_000);
    expect(STATUS_STUCK_DEADLINES_MS.routing!).toBeGreaterThan(35_000);
    expect(STATUS_STUCK_DEADLINES_MS.speaking!).toBeLessThanOrEqual(6_000);
  });
});

describe('speakingHasAudioProgress (follow-up 5)', () => {
  it('áudio Live tocando/pendente OU TTS clássico audível = progresso (re-arma o relógio)', () => {
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 500, pendingLiveChunks: 0, localAudioAudible: false }),
    ).toBe(true);
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 3, localAudioAudible: false }),
    ).toBe(true);
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 0, localAudioAudible: true }),
    ).toBe(true);
  });

  it('sem nenhum áudio = sem progresso (o deadline de speaking conta)', () => {
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 0, localAudioAudible: false }),
    ).toBe(false);
  });
});

describe('wiring do watchdog no voice-controller (follow-up 3iii)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

  it('o tick usa speakingHasAudioProgress com os 3 sinais (Live + clássico)', () => {
    expect(source).toContain('speakingHasAudioProgress({');
    expect(source).toContain('localAudioAudible: isLocalAudioAudible(Date.now())');
  });

  it('force-idle LIBERA busy antes de setar idle (pipeline nunca fica preso)', () => {
    const tickIdx = source.indexOf("statusWatchdogAction(watchedStatus, stuckMs) === 'force-idle'");
    expect(tickIdx).toBeGreaterThanOrEqual(0);
    const busyIdx = source.indexOf('busy.current = false;', tickIdx);
    const idleIdx = source.indexOf("setStatus('idle')", tickIdx);
    expect(busyIdx).toBeGreaterThan(tickIdx);
    expect(idleIdx).toBeGreaterThan(busyIdx);
  });
});
