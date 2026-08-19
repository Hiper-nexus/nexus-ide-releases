import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeDictationTargetClaim,
  claimDictationTarget,
  deliverDictationToClaim,
  hasDictationTargetClaim,
  resetDictationTargetForTests,
} from './dictation-target';

afterEach(() => {
  resetDictationTargetForTests();
});

describe('dictation target claim (ditado no wizard)', () => {
  it('sem claim, a entrega devolve null e o roteamento de panes segue', () => {
    expect(hasDictationTargetClaim()).toBe(false);
    expect(deliverDictationToClaim('texto')).toBeNull();
  });

  it('claim ativo recebe o transcript e reporta o pseudo-pane da UI', () => {
    const onTranscript = vi.fn();
    claimDictationTarget('mission-objective', onTranscript);

    const delivered = deliverDictationToClaim('refaça o fluxo de cadastro');

    expect(onTranscript).toHaveBeenCalledWith('refaça o fluxo de cadastro');
    expect(delivered).toEqual({ paneId: 'ui:mission-objective' });
  });

  it('release é idempotente e não derruba claim alheio', () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = claimDictationTarget('a', first);
    claimDictationTarget('b', second);

    // O release do claim antigo não pode liberar o novo.
    releaseFirst();
    expect(activeDictationTargetClaim()?.id).toBe('b');

    expect(deliverDictationToClaim('fala')).toEqual({ paneId: 'ui:b' });
    expect(second).toHaveBeenCalledWith('fala');
    expect(first).not.toHaveBeenCalled();
  });

  it('callback que lança não vaza a fala para o roteamento de panes', () => {
    claimDictationTarget('broken', () => {
      throw new Error('surface bug');
    });
    // Claim existe: a entrega é o contrato — sucesso reportado, sem throw.
    expect(deliverDictationToClaim('fala')).toEqual({ paneId: 'ui:broken' });
  });

  it('release limpa o claim e volta ao roteamento de panes', () => {
    const release = claimDictationTarget('x', vi.fn());
    release();
    expect(hasDictationTargetClaim()).toBe(false);
    expect(deliverDictationToClaim('fala')).toBeNull();
  });
});
