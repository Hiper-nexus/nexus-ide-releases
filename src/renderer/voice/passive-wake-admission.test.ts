import { describe, expect, it } from 'vitest';
import { PassiveWakeAdmission } from './passive-wake-admission';

describe('PassiveWakeAdmission', () => {
  it('drops tiny/quiet ambient clips before STT', () => {
    const gate = new PassiveWakeAdmission();
    expect(gate.shouldTranscribe({ rawSpeechMs: 200, rawMaxRms: 0.2 }, 1_000)).toBe(false);
    expect(gate.shouldTranscribe({ rawSpeechMs: 800, rawMaxRms: 0.02 }, 1_000)).toBe(false);
  });

  it('admits a normal spoken wake and applies only a bounded reject backoff', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    expect(gate.shouldTranscribe(speech, 1_000)).toBe(true);
    gate.reject(1_000);
    expect(gate.shouldTranscribe(speech, 3_999)).toBe(false);
    expect(gate.shouldTranscribe(speech, 4_000)).toBe(true);
  });

  it('clears backoff after a valid wake', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.accept();
    expect(gate.shouldTranscribe(speech, 1_001)).toBe(true);
  });
});
