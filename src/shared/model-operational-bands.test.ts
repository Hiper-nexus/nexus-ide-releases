import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL_DOCTRINE,
  bandForSpecialty,
  classifyOperationalBand,
  degradeOperationalBand,
  effortForBand,
  groupByOperationalBand,
  pickForBandWithDegrade,
  preferOperationalBand,
  resolveNeedBand,
} from './model-operational-bands';

describe('classifyOperationalBand', () => {
  it('marca free/cheap/low como rápido', () => {
    expect(classifyOperationalBand({ availability: 'free' })).toBe('fast');
    expect(classifyOperationalBand({ availability: 'cheap' })).toBe('fast');
    expect(classifyOperationalBand({ costTier: 'low' })).toBe('fast');
  });

  it('marca high como profundo e medium como equilibrado', () => {
    expect(classifyOperationalBand({ costTier: 'high' })).toBe('deep');
    expect(
      classifyOperationalBand({ costTier: 'medium', availability: 'paid' }),
    ).toBe('balanced');
  });

  it('desconhecido cai em equilibrado — default DOWN, nunca UP', () => {
    expect(classifyOperationalBand({})).toBe('balanced');
    expect(classifyOperationalBand(null)).toBe('balanced');
  });
});

describe('bandForSpecialty + effort', () => {
  it('doc é rápido; security/bug/ops são profundos; o resto equilibra', () => {
    expect(bandForSpecialty('doc')).toBe('fast');
    expect(bandForSpecialty('security')).toBe('deep');
    expect(bandForSpecialty('bug')).toBe('deep');
    expect(bandForSpecialty('ops')).toBe('deep');
    expect(bandForSpecialty('visual')).toBe('balanced');
    expect(bandForSpecialty('feature')).toBe('balanced');
    expect(bandForSpecialty('general')).toBe('balanced');
  });

  it('effort da faixa nunca sobe um deep para xhigh sozinho', () => {
    expect(effortForBand('fast')).toBe('low');
    expect(effortForBand('balanced')).toBe('medium');
    expect(effortForBand('deep')).toBe('high');
  });
});

describe('preferOperationalBand + degrade', () => {
  const pool = [
    { id: 'haiku', band: 'fast' as const },
    { id: 'sonnet', band: 'balanced' as const },
    { id: 'opus', band: 'deep' as const },
    { id: 'glm', band: 'fast' as const },
  ];

  it('traz a faixa-alvo para a frente sem embaralhar o resto', () => {
    expect(
      preferOperationalBand(pool, (item) => item.band, 'deep').map((item) => item.id),
    ).toEqual(['opus', 'haiku', 'sonnet', 'glm']);
  });

  it('é no-op quando ninguém está na faixa — não inventa vencedor', () => {
    const sóRápido = pool.filter((item) => item.band === 'fast');
    expect(preferOperationalBand(sóRápido, (item) => item.band, 'deep')).toEqual(
      sóRápido,
    );
  });

  it('degrada profundo → equilibrado → rápido, nunca sobe', () => {
    expect(degradeOperationalBand('deep')).toBe('balanced');
    expect(degradeOperationalBand('balanced')).toBe('fast');
    expect(degradeOperationalBand('fast')).toBeNull();

    const pick = pickForBandWithDegrade(
      pool.filter((item) => item.band !== 'deep'),
      (item) => item.band,
      'deep',
    );
    expect(pick).toMatchObject({
      item: { id: 'sonnet' },
      band: 'balanced',
      degraded: true,
    });
  });

  it('pool vazio devolve null', () => {
    expect(pickForBandWithDegrade([], () => 'fast', 'fast')).toBeNull();
  });
});

describe('groupByOperationalBand + resolveNeedBand', () => {
  it('agrupa sem inventar faixa para item sem band', () => {
    const groups = groupByOperationalBand(
      [
        { id: 'a', band: 'fast' as const },
        { id: 'b', band: undefined },
        { id: 'c', band: 'deep' as const },
      ],
      (item) => item.band,
    );
    expect(groups.fast.map((item) => item.id)).toEqual(['a']);
    expect(groups.balanced).toEqual([]);
    expect(groups.deep.map((item) => item.id)).toEqual(['c']);
  });

  it('necessidade de doc cai em rápido; override explícito vence', () => {
    const doc = resolveNeedBand('atualizar o README com o guia de instalação');
    expect(doc.specialty).toBe('doc');
    expect(doc.band).toBe('fast');

    const forced = resolveNeedBand(
      'atualizar o README com o guia de instalação',
      'deep',
    );
    expect(forced.band).toBe('deep');
    expect(forced.specialty).toBe('doc');
  });

  it('sem necessidade o padrão é equilibrado', () => {
    expect(resolveNeedBand(undefined).band).toBe('balanced');
    expect(resolveNeedBand('   ').band).toBe('balanced');
  });

  it('a doutrina declara default-down — o contrato que o Overclock usa', () => {
    expect(OPERATIONAL_DOCTRINE.rule).toBe('default-down');
    expect(OPERATIONAL_DOCTRINE.bands.fast).toMatch(/mecânico/i);
  });
});
