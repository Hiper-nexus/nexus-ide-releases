import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS,
  DEFAULT_DUPLEX_MODE,
  HALF_DUPLEX_INPUT_CONSTRAINTS,
  duplexModePolicy,
  resolveDuplexStatus,
} from './duplex-mode-policy';

describe('duplex mode policy', () => {
  it('defaults to the existing safe half-duplex contract', () => {
    expect(DEFAULT_DUPLEX_MODE).toBe('half-duplex');
    expect(duplexModePolicy()).toEqual({
      mode: 'half-duplex',
      status: 'half-duplex',
      inputConstraints: HALF_DUPLEX_INPUT_CONSTRAINTS,
      keepHalfDuplexMicGate: true,
    });
  });

  it('requests only Chromium echo cancellation in probe mode', () => {
    expect(CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(duplexModePolicy('chromium-aec-probe')).toEqual({
      mode: 'chromium-aec-probe',
      status: 'chromium-aec-pending',
      inputConstraints: CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS,
      keepHalfDuplexMicGate: true,
    });
  });

  it('reports probe lifecycle from the actual Chromium track setting', () => {
    expect(resolveDuplexStatus('chromium-aec-probe')).toBe('chromium-aec-pending');
    expect(resolveDuplexStatus('chromium-aec-probe', { echoCancellation: true })).toBe(
      'chromium-aec-active',
    );
    expect(resolveDuplexStatus('chromium-aec-probe', { echoCancellation: false })).toBe(
      'chromium-aec-unavailable',
    );
    expect(resolveDuplexStatus('chromium-aec-probe', {})).toBe(
      'chromium-aec-unavailable',
    );
  });

  it('never treats the probe as permission for simultaneous microphone streaming', () => {
    expect(duplexModePolicy('chromium-aec-probe').keepHalfDuplexMicGate).toBe(true);
  });
});
