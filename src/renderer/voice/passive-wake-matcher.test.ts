import { describe, expect, it } from 'vitest';
import {
  isTrustedPassiveEmbeddedCommand,
  isTrustedPassiveWakeOnly,
  matchPassiveWakeWord,
} from './passive-wake-matcher';

describe('matchPassiveWakeWord (= peer ADE matchWakeWord)', () => {
  it('gives wake-only authority only to the exact configured name', () => {
    expect(isTrustedPassiveWakeOnly('Jarvis')).toBe(true);
    expect(isTrustedPassiveWakeOnly('Ei, Jarvis!')).toBe(true);
    expect(isTrustedPassiveWakeOnly('jars')).toBe(false);
    expect(isTrustedPassiveWakeOnly('jar')).toBe(false);
    expect(isTrustedPassiveWakeOnly('obrigado Jarvis')).toBe(false);
  });
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

  it('matches any-position exact (peer ADE F-057)', () => {
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

describe('isTrustedPassiveEmbeddedCommand', () => {
  it.each([
    'Jarvis abra o terminal',
    'Ei Jarvis, analise os logs',
    'ok jarvis cria uma missão',
  ])('aceita nome exato no início: %s', (text) => {
    expect(isTrustedPassiveEmbeddedCommand(text)).toBe(true);
  });

  it.each([
    'obrigado jarvis abra o log',
    'o vídeo disse jarvis abra tudo',
    'jarbas mostra os panes',
    'e ja abre o terminal',
    'Jarvis',
  ])('não autoriza comando ambiente/fuzzy: %s', (text) => {
    expect(isTrustedPassiveEmbeddedCommand(text)).toBe(false);
  });

  it('suporta nome personalizado de várias palavras', () => {
    expect(isTrustedPassiveEmbeddedCommand('Ei Sexta Feira abra o terminal', 'Sexta Feira')).toBe(true);
  });
});
