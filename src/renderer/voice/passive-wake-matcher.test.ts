import { describe, expect, it } from 'vitest';
import { matchPassiveWakeWord } from './passive-wake-matcher';

describe('matchPassiveWakeWord (= Overclock matchWakeWord)', () => {
  it('matches jarvis + command rest', () => {
    expect(matchPassiveWakeWord('Ei Jarvis, abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
    expect(matchPassiveWakeWord('jarvis cria uma missão de QA')).toEqual({
      command: 'cria uma missão de QA',
    });
  });

  it('matches aliases and fillers', () => {
    expect(matchPassiveWakeWord('hey jarbas mostra os panes')?.command).toBe(
      'mostra os panes',
    );
    expect(matchPassiveWakeWord('jarbis executa')).not.toBeNull();
    expect(matchPassiveWakeWord('oi jarvis')).toEqual({ command: '' });
  });

  it('matches truncated STT from production logs', () => {
    expect(matchPassiveWakeWord('e ja')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('ei ja')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('aja')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('eijarbas mostre')).not.toBeNull();
  });

  it('matches any-position exact (Overclock F-057)', () => {
    expect(matchPassiveWakeWord('obrigado jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Obrigado. Jarvis.')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('obrigado jarvis abre o log')?.command).toBe(
      'abre o log',
    );
  });

  it('rejects ambient fuzzy mid-sentence', () => {
    expect(matchPassiveWakeWord('hoje o jarbas me ligou cedo')).toBeNull();
  });

  it('custom assistant name', () => {
    expect(matchPassiveWakeWord('Alfredo, abra os logs', 'Alfredo')).toEqual({
      command: 'abra os logs',
    });
  });
});
