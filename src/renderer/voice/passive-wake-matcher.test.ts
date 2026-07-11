import { describe, expect, it } from 'vitest';
import { matchPassiveWakeWord } from './passive-wake-matcher';

describe('matchPassiveWakeWord', () => {
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

  it('does not accept arbitrary words that merely end in the assistant name', () => {
    expect(matchPassiveWakeWord('superjarvis abra o terminal')).toBeNull();
  });

  it('does not treat an ambient near-match as an address', () => {
    expect(matchPassiveWakeWord('hoje o jarvix falou comigo')).toBeNull();
    expect(matchPassiveWakeWord('hoje o Jarvis falou comigo')).toBeNull();
    expect(matchPassiveWakeWord('eu estava explicando sobre o Jarvis')).toBeNull();
  });

  it('rejects production aliases when they are ambient speech, not an address', () => {
    expect(matchPassiveWakeWord('o Jasper chegou hoje')).toBeNull();
    expect(matchPassiveWakeWord('falaram Eijax no vídeo')).toBeNull();
    expect(matchPassiveWakeWord('a voz disse Rejaves ontem')).toBeNull();
    expect(matchPassiveWakeWord('eu conheço o Jacques do trabalho')).toBeNull();
  });

  it('supports an exact configured assistant name', () => {
    expect(matchPassiveWakeWord('Alfredo, abra os logs', 'Alfredo')).toEqual({
      command: 'abra os logs',
    });
  });

  it('wakes on name alone and near-miss STT (product: any close Jarvis)', () => {
    expect(matchPassiveWakeWord('Jarvis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('javis')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('javes')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Jarvi')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('jarviz')).toEqual({ command: '' });
    expect(matchPassiveWakeWord('Jarvis,')).toEqual({ command: '' });
  });

  it('wakes on vocative variants without requiring Hey (product PT)', () => {
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
