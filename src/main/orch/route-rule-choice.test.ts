import { afterEach, describe, expect, it, vi } from 'vitest';
import { ruleChoiceReceipt } from './route-rule-choice';

const final = { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ruleChoiceReceipt — contrafactual "o que a regra teria escolhido"', () => {
  it('Jev não influenciou: nada a comparar e a regra nem é recalculada', () => {
    const routeByRule = vi.fn(() => ({ adapterId: 'codex' }));
    expect(ruleChoiceReceipt({ jevInfluenced: false, final, routeByRule })).toBeUndefined();
    expect(routeByRule).not.toHaveBeenCalled();
  });

  it('a regra escolheria outra CLI: devolve só adapterId/model/effort dela', () => {
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final,
        routeByRule: () => ({ adapterId: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }),
      }),
    ).toEqual({ adapterId: 'codex', model: 'gpt-5.6-luna', effort: 'medium' });
  });

  it('mesma CLI com outro modelo, ou só outro esforço, também é divergência', () => {
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final,
        routeByRule: () => ({ adapterId: 'claude', model: 'claude-sonnet-5', effort: 'high' }),
      }),
    ).toEqual({ adapterId: 'claude', model: 'claude-sonnet-5', effort: 'high' });
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final,
        routeByRule: () => ({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'medium' }),
      }),
    ).toEqual({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
  });

  it('o Jev concorda com a regra: "same"', () => {
    expect(ruleChoiceReceipt({ jevInfluenced: true, final, routeByRule: () => ({ ...final }) })).toBe('same');
    // Sem modelo/esforço nos dois lados também é igual.
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final: { adapterId: 'kimi' },
        routeByRule: () => ({ adapterId: 'kimi' }),
      }),
    ).toBe('same');
  });

  it('esforço presente de um lado só diverge; omitido na regra não é inventado', () => {
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final,
        routeByRule: () => ({ adapterId: 'claude', model: 'claude-opus-5-5' }),
      }),
    ).toEqual({ adapterId: 'claude', model: 'claude-opus-5-5' });
  });

  it('privacidade: campos extras da decisão da regra (reason, alternativas) nunca saem', () => {
    const rich = {
      adapterId: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'low',
      reason: 'medium; sinais: revisar o contrato do cliente Fulano',
      alternatives: [{ adapterId: 'kimi' }],
      accountId: 'conta-secreta',
    };
    const receipt = ruleChoiceReceipt({ jevInfluenced: true, final, routeByRule: () => rich });
    expect(receipt).toEqual({ adapterId: 'codex', model: 'gpt-5.6-luna', effort: 'low' });
    expect(JSON.stringify(receipt)).not.toMatch(/Fulano|conta-secreta|alternatives|reason/);
  });

  it('fail-open: regra sem decisão ou recálculo que lança não derruba a rota', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(ruleChoiceReceipt({ jevInfluenced: true, final, routeByRule: () => null })).toBeUndefined();
    expect(
      ruleChoiceReceipt({
        jevInfluenced: true,
        final,
        routeByRule: () => {
          throw new Error('boom');
        },
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
