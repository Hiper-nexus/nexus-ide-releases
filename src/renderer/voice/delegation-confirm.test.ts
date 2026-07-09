import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyConfirmationReply,
  clearPendingDelegation,
  DELEGATION_CONFIRM_TTL_MS,
  delegationConfirmPrompt,
  peekPendingDelegation,
  resolveDelegationReply,
  setPendingDelegation,
} from './delegation-confirm';

const T0 = 1_000_000;

beforeEach(() => clearPendingDelegation());

describe('DELEGATION_CONFIRM_TTL_MS', () => {
  it('janela apertada — no máximo 15s (C3: pendência não pode viver sessão inteira)', () => {
    expect(DELEGATION_CONFIRM_TTL_MS).toBeLessThanOrEqual(15_000);
  });
});

describe('classifyConfirmationReply', () => {
  it('afirmativas PT-BR viram yes', () => {
    for (const t of ['sim', 'pode mandar', 'confirmo', 'manda ver', 'beleza', 'ok']) {
      expect(classifyConfirmationReply(t)).toBe('yes');
    }
  });

  it('negativas viram no — e negativa GANHA de afirmativa ("não pode")', () => {
    for (const t of ['não', 'nao pode', 'cancela', 'espera', 'melhor não, deixa']) {
      expect(classifyConfirmationReply(t)).toBe('no');
    }
  });

  it('resto é other (mudou de assunto)', () => {
    expect(classifyConfirmationReply('abre o navegador pra mim')).toBe('other');
    expect(classifyConfirmationReply('')).toBe('other');
  });

  it('afirmativa embutida em comando NÃO confirma — só confirmação isolada (follow-up 1)', () => {
    for (const t of [
      'pode abrir o terminal',
      'vai lá e conserta o bug do login',
      'isso que eu falei ontem tá errado',
      'manda um email pro chefe',
      'beleza, agora abre o navegador',
      'ok jarvis me mostra o board de missões agora',
    ]) {
      expect(classifyConfirmationReply(t)).toBe('other');
    }
  });

  it('borda de AFFIRMATIVE_MAX_WORDS: 6 palavras ainda confirma, 7 não', () => {
    expect(classifyConfirmationReply('sim sim sim sim sim sim')).toBe('yes');
    expect(classifyConfirmationReply('sim sim sim sim sim sim sim')).toBe('other');
  });

  it('confirmações curtas naturais seguem valendo', () => {
    for (const t of [
      'sim',
      'sim, pode mandar',
      'confirmo',
      'confirmado',
      'pode mandar pro squad',
      'manda ver',
      'isso aí',
      'demorou',
      'com certeza',
      'beleza, manda',
    ]) {
      expect(classifyConfirmationReply(t)).toBe('yes');
    }
  });
});

describe('pending delegation lifecycle', () => {
  const delegation = {
    targetPaneId: 'pane-1',
    text: 'Fix the flaky test in auth',
    createdAt: T0,
  };

  it('sim → dispatch com a delegação, e limpa o estado', () => {
    setPendingDelegation(delegation);
    const r = resolveDelegationReply('sim, pode mandar', T0 + 1_000);
    expect(r).toEqual({ kind: 'dispatch', delegation });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('não → cancel, e limpa', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('não, cancela', T0 + 1_000)).toEqual({ kind: 'cancel' });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('mudou de assunto → drop com a delegação (descartada, mas NUNCA muda: sem sim não despacha)', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('que horas são?', T0 + 1_000)).toEqual({
      kind: 'drop',
      delegation,
    });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('expira após o TTL', () => {
    setPendingDelegation(delegation);
    expect(peekPendingDelegation(T0 + DELEGATION_CONFIRM_TTL_MS + 1)).toBeNull();
    expect(resolveDelegationReply('sim', T0 + DELEGATION_CONFIRM_TTL_MS + 1)).toEqual({
      kind: 'none',
    });
  });

  it('sem pendência → none', () => {
    expect(resolveDelegationReply('sim', T0)).toEqual({ kind: 'none' });
  });
});

describe('delegationConfirmPrompt', () => {
  it('fala a primeira linha truncada + Confirmo?', () => {
    const p = delegationConfirmPrompt('Implement retry logic in the queue\nDetails: ...');
    expect(p).toBe('Vou mandar pro squad: Implement retry logic in the queue. Confirmo?');
  });

  it('trunca linhas longas com reticências', () => {
    const p = delegationConfirmPrompt('x'.repeat(200));
    expect(p).toContain('…');
    expect(p.length).toBeLessThan(130);
  });
});
