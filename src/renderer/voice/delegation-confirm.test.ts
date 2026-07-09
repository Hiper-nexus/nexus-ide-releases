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

  it('mudou de assunto → none, missão descartada (NUNCA despacha sem sim)', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('que horas são?', T0 + 1_000)).toEqual({ kind: 'none' });
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
