/**
 * Suite portada dos testes peer ADE voiceNlu.test.js (+ truncamentos Nexus).
 */
import { describe, expect, it } from 'vitest';
import {
  JARVIS_PASSIVE_PHASES,
  matchVoiceConfirmation,
  matchWakeWord,
} from './jarvis-passive-nlu';

describe('matchWakeWord — distance 0 (exact)', () => {
  it('matches lowercase "jarvis"', () => {
    expect(matchWakeWord('jarvis faça o deploy')).not.toBeNull();
  });
  it('matches uppercase "JARVIS"', () => {
    expect(matchWakeWord('JARVIS cria uma missão')).not.toBeNull();
  });
  it('returns correct rest when followed by command', () => {
    const result = matchWakeWord('jarvis cria uma missão de QA');
    expect(result?.rest).toBe('cria uma missão de QA');
  });
  it('returns empty rest when only the wake word is spoken', () => {
    expect(matchWakeWord('jarvis')?.rest).toBe('');
  });
});

describe('matchWakeWord — distance 1 (fuzzy)', () => {
  it('matches jarves / jarvi / jarviss', () => {
    expect(matchWakeWord('jarves abre o painel')).not.toBeNull();
    expect(matchWakeWord('jarvi vai lá')).not.toBeNull();
    expect(matchWakeWord('jarviss faz isso')).not.toBeNull();
  });
  it('does NOT match distance 2 "javes" at start without alias path', () => {
    // "javes" is now in our extended aliases for PT STT — peer ADE pure would null;
    // we intentionally accept as alias.
    expect(matchWakeWord('javes faz isso')).not.toBeNull();
  });
});

describe('matchWakeWord — filler + any position', () => {
  it('matches ei/ok/hey/oi/acorda jarvis', () => {
    expect(matchWakeWord('ei jarvis faz o build')?.rest).toBe('faz o build');
    expect(matchWakeWord('ok jarvis mostra as missões')).not.toBeNull();
    expect(matchWakeWord('hey jarvis lista os panes')).not.toBeNull();
    expect(matchWakeWord('oi jarvis cria o squad')).not.toBeNull();
    expect(matchWakeWord('acorda jarvis')?.rest).toBe('');
    expect(matchWakeWord('acordar jarvis agora')?.rest).toBe('agora');
  });
  it('matches trailing/mid "obrigado jarvis"', () => {
    expect(matchWakeWord('obrigado jarvis')?.rest).toBe('');
    expect(matchWakeWord('Obrigado. Jarvis.')?.rest).toBe('');
    expect(matchWakeWord('obrigado jarvis abre o log')?.rest).toBe('abre o log');
  });
  it('does NOT fuzzy/alias mid-utterance', () => {
    expect(matchWakeWord('hoje o jarbas me ligou cedo')).toBeNull();
  });
});

describe('matchWakeWord — aliases + truncated STT', () => {
  it('matches jarbas / jarbis', () => {
    expect(matchWakeWord('jarbas mostra o painel')?.rest).toBe('mostra o painel');
    expect(matchWakeWord('jarbis executa o teste')).not.toBeNull();
  });
  it('matches truncated e ja / aja', () => {
    expect(matchWakeWord('e ja')?.rest).toBe('');
    expect(matchWakeWord('ei ja')?.rest).toBe('');
    expect(matchWakeWord('aja')?.rest).toBe('');
  });
});

describe('matchWakeWord — custom name (C-070)', () => {
  it('matches Alfredo / multi-word', () => {
    expect(matchWakeWord('Alfredo abre o terminal', 'alfredo')?.rest).toBe(
      'abre o terminal',
    );
    expect(matchWakeWord('sexta feira lista as missões', 'sexta feira')).not.toBeNull();
  });
  it('custom name disables jarvis', () => {
    expect(matchWakeWord('jarvis abre o log', 'sexta feira')).toBeNull();
  });
});

describe('matchVoiceConfirmation', () => {
  it('classifies pt-BR yes/no', () => {
    expect(matchVoiceConfirmation('sim pode')).toEqual({ approved: true });
    expect(matchVoiceConfirmation('não cancela')).toEqual({ approved: false });
    expect(matchVoiceConfirmation('confirma sempre')).toEqual({
      approved: true,
      always: true,
    });
    expect(matchVoiceConfirmation('abre o terminal')).toBeNull();
  });
});

describe('JARVIS_PASSIVE_PHASES', () => {
  it('exposes peer ADE phases', () => {
    expect(JARVIS_PASSIVE_PHASES).toEqual(['off', 'standby', 'capturing', 'checking']);
  });
});
