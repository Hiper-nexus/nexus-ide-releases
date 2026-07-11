import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS,
  DEFAULT_DUPLEX_MODE,
  FULL_DUPLEX_INPUT_CONSTRAINTS,
  HALF_DUPLEX_INPUT_CONSTRAINTS,
  duplexModePolicy,
  resolveDuplexStatus,
} from './duplex-mode-policy';

describe('duplex mode policy', () => {
  it('defaults to full-duplex with open mic gate', () => {
    expect(DEFAULT_DUPLEX_MODE).toBe('full-duplex');
    expect(duplexModePolicy()).toEqual({
      mode: 'full-duplex',
      status: 'full-duplex',
      inputConstraints: FULL_DUPLEX_INPUT_CONSTRAINTS,
      keepHalfDuplexMicGate: false,
    });
  });

  it('keeps half-duplex as the safe contract when requested', () => {
    expect(duplexModePolicy('half-duplex')).toEqual({
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

  it('reports full-duplex AEC availability from track settings', () => {
    expect(resolveDuplexStatus('full-duplex', { echoCancellation: true })).toBe(
      'full-duplex',
    );
    expect(resolveDuplexStatus('full-duplex', { echoCancellation: false })).toBe(
      'chromium-aec-unavailable',
    );
  });

  it('opens the mic gate only in full-duplex mode', () => {
    expect(duplexModePolicy('full-duplex').keepHalfDuplexMicGate).toBe(false);
    expect(duplexModePolicy('chromium-aec-probe').keepHalfDuplexMicGate).toBe(true);
    expect(duplexModePolicy('half-duplex').keepHalfDuplexMicGate).toBe(true);
  });
});
