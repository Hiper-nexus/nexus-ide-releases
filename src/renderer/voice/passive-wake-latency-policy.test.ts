import { describe, expect, it } from 'vitest';
import {
  PASSIVE_WAKE_LATENCY_POLICY,
  passiveWakeWorstCaseCaptureMs,
} from './passive-wake-latency-policy';

describe('passive wake latency policy', () => {
  it('keeps the STT safety-net capture below a realtime interaction budget', () => {
    expect(PASSIVE_WAKE_LATENCY_POLICY.maxMs).toBeLessThanOrEqual(1_800);
    expect(passiveWakeWorstCaseCaptureMs()).toBeLessThanOrEqual(2_500);
  });

  it('retains a bounded endpoint tail and immediate rolling rearm', () => {
    expect(PASSIVE_WAKE_LATENCY_POLICY.silenceMs).toBeGreaterThanOrEqual(650);
    expect(PASSIVE_WAKE_LATENCY_POLICY.cooldownMs).toBeLessThanOrEqual(100);
    expect(PASSIVE_WAKE_LATENCY_POLICY.forceEmitMinPeakRms).toBeGreaterThan(0);
  });
});
