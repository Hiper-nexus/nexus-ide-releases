import { describe, expect, it } from 'vitest';
import { PassiveWakeAdmission } from './passive-wake-admission';

describe('PassiveWakeAdmission', () => {
  it('drops tiny/quiet ambient clips before STT', () => {
    const gate = new PassiveWakeAdmission();
    expect(gate.shouldTranscribe({ rawSpeechMs: 200, rawMaxRms: 0.2 }, 1_000)).toBe(false);
    expect(gate.shouldTranscribe({ rawSpeechMs: 800, rawMaxRms: 0.02 }, 1_000)).toBe(false);
  });

  it('admits a normal spoken wake and starts with a 3s reject backoff', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    expect(gate.shouldTranscribe(speech, 1_000)).toBe(true);
    gate.reject(1_000);
    expect(gate.shouldTranscribe(speech, 3_999)).toBe(false);
    expect(gate.shouldTranscribe(speech, 4_000)).toBe(true);
  });

  it('backs off adaptively at 3s, 6s and a hard ceiling of 10s', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    expect(gate.shouldTranscribe(speech, 4_000)).toBe(true);
    gate.reject(4_000);
    expect(gate.shouldTranscribe(speech, 9_999)).toBe(false);
    expect(gate.shouldTranscribe(speech, 10_000)).toBe(true);
    gate.reject(10_000);
    expect(gate.shouldTranscribe(speech, 19_999)).toBe(false);
    expect(gate.shouldTranscribe(speech, 20_000)).toBe(true);
    gate.reject(20_000);
    expect(gate.shouldTranscribe(speech, 30_000)).toBe(true);
  });

  it('forgets an old ambient streak after 30 seconds', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.reject(4_000);
    gate.reject(40_001);
    expect(gate.shouldTranscribe(speech, 43_000)).toBe(false);
    expect(gate.shouldTranscribe(speech, 43_001)).toBe(true);
  });

  it('clears backoff after a valid wake', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.accept();
    expect(gate.shouldTranscribe(speech, 1_001)).toBe(true);
  });
});
