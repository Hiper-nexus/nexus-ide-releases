import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS,
  DEFAULT_DUPLEX_MODE,
  FULL_DUPLEX_INPUT_CONSTRAINTS,
  HALF_DUPLEX_INPUT_CONSTRAINTS,
  duplexModePolicy,
  liveMicFullDuplex,
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

describe('liveMicFullDuplex honours the real AEC status', () => {
  it('keeps full-duplex (open mic for barge-in) when Chromium AEC is active', () => {
    expect(liveMicFullDuplex({ mode: 'full-duplex', aecStatus: 'full-duplex' })).toBe(true);
    expect(liveMicFullDuplex({ mode: 'full-duplex', aecStatus: 'chromium-aec-active' })).toBe(true);
  });

  it('drops to a gated mic when AEC is confirmed unavailable', () => {
    // Core bug: the mic kept flowing to Gemini while she spoke; without AEC the
    // echo of her own voice tripped START_OF_ACTIVITY_INTERRUPTS and cut the
    // generation (silent turn). A gated mic while speaking prevents that.
    expect(liveMicFullDuplex({ mode: 'full-duplex', aecStatus: 'chromium-aec-unavailable' })).toBe(false);
  });

  it('keeps the mode default while the AEC probe is still pending', () => {
    expect(liveMicFullDuplex({ mode: 'full-duplex', aecStatus: 'chromium-aec-pending' })).toBe(true);
  });

  it('stays gated in half-duplex mode regardless of status', () => {
    expect(liveMicFullDuplex({ mode: 'half-duplex', aecStatus: 'half-duplex' })).toBe(false);
  });
});
