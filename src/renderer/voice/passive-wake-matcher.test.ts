import { describe, expect, it } from 'vitest';
import { matchPassiveWakeWord } from './passive-wake-matcher';

describe('matchPassiveWakeWord (Overclock-style)', () => {
  it('recognizes a direct Portuguese wake and retains the command', () => {
    expect(matchPassiveWakeWord('Ei Jarvis, abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
  });

  it('accepts common STT aliases at the start of the utterance', () => {
    expect(matchPassiveWakeWord('hey jarbas mostra os panes')).toEqual({
      command: 'mostra os panes',
    });
    expect(matchPassiveWakeWord('jarvix pode me ouvir')).toEqual({
      command: 'pode me ouvir',
    });
    expect(matchPassiveWakeWord('ei jackson, abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
    expect(matchPassiveWakeWord('Jarvi, abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
    expect(matchPassiveWakeWord('hey charvis continua')).toEqual({
      command: 'continua',
    });
  });

  it('accepts the aliases observed in production only as a direct address', () => {
    expect(matchPassiveWakeWord('Ei Jasper, abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
    expect(matchPassiveWakeWord('Eijax me escuta')).toEqual({
      command: 'me escuta',
    });
    expect(matchPassiveWakeWord('Rejaves continue a tarefa')).toEqual({
      command: 'continue a tarefa',
    });
    expect(matchPassiveWakeWord('Jacques, mostre os logs')).toEqual({
      command: 'mostre os logs',
    });
  });

  it('accepts a greeting joined to the name by fast STT', () => {
    expect(matchPassiveWakeWord('heyjarvis abra o terminal')).toEqual({
      command: 'abra o terminal',
    });
    expect(matchPassiveWakeWord('eijarbas mostre os panes')).toEqual({
      command: 'mostre os panes',
    });
  });

  it('accepts truncated STT from real logs (e ja / aja)', () => {
    expect(matchPassiveWakeWord('e ja')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('ei ja')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('e jar')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('aja')).toEqual({ command: '' });
  });

  it('does not accept arbitrary words that merely end in the assistant name', () => {
    expect(matchPassiveWakeWord('superjarvis abra o terminal')).toBeNull();
  });

  it('wakes on exact Jarvis mid/end phrase (Overclock F-057)', () => {
    expect(matchPassiveWakeWord('obrigado jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Obrigado. Jarvis.')).toEqual({ command: '' });
    // exact mid-sentence is intentional Overclock behavior
    expect(matchPassiveWakeWord('hoje o Jarvis falou comigo')).toEqual({
      command: 'falou comigo',
    });
  });

  it('rejects ambient fuzzy aliases only after the first two tokens', () => {
    // Overclock: fuzzy/alias só i < 2 — no meio da frase, null
    expect(matchPassiveWakeWord('hoje o jarbas me ligou cedo')).toBeNull();
    expect(matchPassiveWakeWord('conversei com o garvis ontem')).toBeNull();
    expect(matchPassiveWakeWord('a voz disse Rejaves ontem')).toBeNull();
  });

  it('supports an exact configured assistant name', () => {
    expect(matchPassiveWakeWord('Alfredo, abra os logs', 'Alfredo')).toEqual({
      command: 'abra os logs',
    });
  });

  it('wakes on name alone and near-miss STT', () => {
    expect(matchPassiveWakeWord('Jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('javis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('javes')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Jarvi')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('jarviz')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Jarvis,')).toEqual({ command: '' });
  });

  it('wakes on vocative variants without requiring Hey', () => {
    expect(matchPassiveWakeWord('acorda jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('cheguei jarvis abre o terminal')).toEqual({
      command: 'abre o terminal',
    });
    expect(matchPassiveWakeWord('olá jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('ouça jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('ouso jarvis me escuta')).toEqual({
      command: 'me escuta',
    });
    expect(matchPassiveWakeWord('bom dia jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Jarvis, como está?')).toEqual({
      command: 'como está?',
    });
  });
});
