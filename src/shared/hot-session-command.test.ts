import { describe, expect, it } from 'vitest';
import {
  HOT_COMMAND_MIN_PEAK_RMS,
  isAmbientMediaTranscript,
  isHotSessionCommandCandidate,
} from './hot-session-command';

describe('isHotSessionCommandCandidate', () => {
  it('accepts real follow-ups with energy', () => {
    expect(
      isHotSessionCommandCandidate('nova missao', { peakRms: 0.2 }),
    ).toBe(true);
    expect(
      isHotSessionCommandCandidate('abre o terminal', { peakRms: 0.15 }),
    ).toBe(true);
    expect(
      isHotSessionCommandCandidate('lista os panes', { peakRms: 0.12 }),
    ).toBe(true);
  });

  it('rejects ambient / TV STT from real logs', () => {
    expect(
      isHotSessionCommandCandidate('camelo vindo', { peakRms: 0.3 }),
    ).toBe(false);
    expect(
      isHotSessionCommandCandidate('aplaus', { peakRms: 0.4 }),
    ).toBe(false);
    expect(
      isHotSessionCommandCandidate('a musica de abertu', { peakRms: 0.4 }),
    ).toBe(false);
    expect(
      isHotSessionCommandCandidate('a cidade no brasil', { peakRms: 0.3 }),
    ).toBe(false);
  });

  it('rejects low energy even if text looks ok', () => {
    expect(
      isHotSessionCommandCandidate('nova missao', {
        peakRms: HOT_COMMAND_MIN_PEAK_RMS - 0.01,
      }),
    ).toBe(false);
  });

  it('rejects pure noise', () => {
    expect(isHotSessionCommandCandidate('hmm', { peakRms: 0.5 })).toBe(false);
    expect(isHotSessionCommandCandidate('ah', { peakRms: 0.5 })).toBe(false);
  });

  it('rejects ordinary multi-word conversation without an action cue', () => {
    expect(
      isHotSessionCommandCandidate('essa ideia parece muito boa', { peakRms: 0.3 }),
    ).toBe(false);
    expect(
      isHotSessionCommandCandidate('hoje o tempo esta quente', { peakRms: 0.3 }),
    ).toBe(false);
  });
});

describe('isAmbientMediaTranscript', () => {
  it('flags media boilerplate', () => {
    expect(isAmbientMediaTranscript('obrigado por assistir')).toBe(true);
    expect(isAmbientMediaTranscript('thanks for watching')).toBe(true);
  });
});
