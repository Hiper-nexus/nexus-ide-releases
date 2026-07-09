import { describe, expect, it } from 'vitest';
import {
  STATUS_STUCK_DEADLINES_MS,
  statusWatchdogAction,
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
    expect(STATUS_STUCK_DEADLINES_MS.speaking!).toBeGreaterThan(40_000);
  });
});
