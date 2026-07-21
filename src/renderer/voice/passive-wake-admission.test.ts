import { describe, expect, it } from 'vitest';
import { PassiveWakeAdmission } from './passive-wake-admission';

describe('PassiveWakeAdmission', () => {
  it('drops tiny/quiet ambient clips before STT with explicit reasons', () => {
    const gate = new PassiveWakeAdmission();
    expect(gate.admit({ rawSpeechMs: 200, rawMaxRms: 0.2 }, 1_000)).toEqual({
      admit: false,
      reason: 'weak-speech',
    });
    expect(gate.admit({ rawSpeechMs: 800, rawMaxRms: 0.02 }, 1_000)).toEqual({
      admit: false,
      reason: 'low-peak',
    });
  });

  it('admits a normal spoken wake and starts with a 3s reject backoff', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    expect(gate.admit(speech, 1_000).admit).toBe(true);
    gate.reject(1_000);
    expect(gate.admit(speech, 3_999)).toEqual({
      admit: false,
      reason: 'backoff',
      backoffRemainingMs: 1,
    });
    expect(gate.admit(speech, 4_000).admit).toBe(true);
  });

  it('backs off adaptively at 3s, 6s, 10s, 20s, 40s and a hard ceiling of 60s', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    expect(gate.admit(speech, 4_000).admit).toBe(true);
    gate.reject(4_000);
    expect(gate.admit(speech, 9_999).admit).toBe(false);
    expect(gate.admit(speech, 10_000).admit).toBe(true);
    gate.reject(10_000);
    expect(gate.admit(speech, 19_999).admit).toBe(false);
    expect(gate.admit(speech, 20_000).admit).toBe(true);
    gate.reject(20_000);
    expect(gate.admit(speech, 39_999).admit).toBe(false);
    expect(gate.admit(speech, 40_000).admit).toBe(true);
    gate.reject(40_000);
    expect(gate.admit(speech, 79_999).admit).toBe(false);
    expect(gate.admit(speech, 80_000).admit).toBe(true);
    gate.reject(80_000);
    expect(gate.admit(speech, 139_999).admit).toBe(false);
    expect(gate.admit(speech, 140_000).admit).toBe(true);
    gate.reject(140_000);
    // teto: 60 s de novo, sem crescer além
    expect(gate.admit(speech, 199_999).admit).toBe(false);
    expect(gate.admit(speech, 200_000).admit).toBe(true);
  });

  it('forgets an old ambient streak after 150 seconds of quiet', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.reject(4_000);
    // muito tempo depois, o streak volta ao primeiro degrau (3 s)
    gate.reject(200_001);
    expect(gate.admit(speech, 203_000).admit).toBe(false);
    expect(gate.admit(speech, 203_001).admit).toBe(true);
  });

  it('keeps the streak while backoff is active (gaps smaller than the reset window)', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.reject(4_000);
    gate.reject(10_000);
    // 20 s depois do último reject: streak preservado → próximo degrau é 20 s
    gate.reject(30_000);
    expect(gate.admit(speech, 49_999).admit).toBe(false);
    expect(gate.admit(speech, 50_000).admit).toBe(true);
  });

  it('clears backoff after a valid wake', () => {
    const gate = new PassiveWakeAdmission();
    const speech = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.reject(1_000);
    gate.accept();
    expect(gate.admit(speech, 1_001).admit).toBe(true);
  });

  it('suppresses sustained continuous ambient (TV signature) without STT', () => {
    const gate = new PassiveWakeAdmission();
    const tv = { rawSpeechMs: 1800, rawMaxRms: 0.2, forcedByMax: true };
    expect(gate.admit(tv, 1_000).admit).toBe(true);
    expect(gate.admit(tv, 3_000).admit).toBe(true);
    const third = gate.admit(tv, 5_000);
    expect(third.admit).toBe(false);
    expect(third.reason).toBe('continuous-ambient');
    // a supressão realimenta o backoff: clips seguintes caem em 'backoff'
    const during = gate.admit(tv, 6_000);
    expect(during.admit).toBe(false);
    expect(during.reason).toBe('backoff');
  });

  it('resets the continuous-ambient streak when a clip ends by silence', () => {
    const gate = new PassiveWakeAdmission();
    const tv = { rawSpeechMs: 1800, rawMaxRms: 0.2, forcedByMax: true };
    const human = { rawSpeechMs: 900, rawMaxRms: 0.12 };
    gate.admit(tv, 1_000);
    gate.admit(tv, 3_000);
    // pausa humana (clip fechado por silêncio) zera a assinatura de TV
    expect(gate.admit(human, 5_000).admit).toBe(true);
    gate.reject(5_000);
    // backoff curto expira e os dois clips forçados seguintes ainda não
    // rearmam a assinatura (precisa de 3 consecutivos)
    expect(gate.admit(tv, 8_000).admit).toBe(true);
  });

  it('escalates to the 60s ceiling under uninterrupted TV and stays local', () => {
    const gate = new PassiveWakeAdmission();
    const tv = { rawSpeechMs: 1800, rawMaxRms: 0.2, forcedByMax: true };
    let now = 1_000;
    // priming: 2 clips admitidos, 3º dispara continuous-ambient + reject (3 s)
    gate.admit(tv, now);
    gate.admit(tv, now + 2_000);
    expect(gate.admit(tv, now + 4_000).reason).toBe('continuous-ambient');
    now += 4_000;
    // cada expiração de backoff encontra TV contínua → escala a escada
    for (const expected of [6_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const backoff = gate.admit(tv, now + 1_000);
      expect(backoff.reason).toBe('backoff');
      const verdict = gate.admit(tv, now + 1_000 + (backoff.backoffRemainingMs ?? 0));
      expect(verdict.reason).toBe('continuous-ambient');
      expect(verdict.backoffRemainingMs).toBe(expected);
      now += 1_000 + (backoff.backoffRemainingMs ?? 0);
    }
  });

  it('resets the continuous-ambient streak on accept', () => {
    const gate = new PassiveWakeAdmission();
    const tv = { rawSpeechMs: 1800, rawMaxRms: 0.2, forcedByMax: true };
    gate.admit(tv, 1_000);
    gate.admit(tv, 3_000);
    gate.accept();
    // streak zerado: precisa de 3 novos clips forçados para suprimir
    expect(gate.admit(tv, 4_000).admit).toBe(true);
    expect(gate.admit(tv, 6_000).admit).toBe(true);
    expect(gate.admit(tv, 8_000).reason).toBe('continuous-ambient');
  });
});
