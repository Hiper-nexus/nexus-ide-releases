import { describe, expect, it } from 'vitest';
import {
  advanceStreak,
  businessDaysBetween,
  SHIELDS_PER_MONTH,
  type StreakState,
} from './streak';

const EMPTY: StreakState = {
  streakDays: 0,
  lastDeliveryDay: null,
  shieldsUsedMonth: null,
  shieldsUsed: 0,
};

// 2026-07-06 é segunda; 07-03 é sexta; 07-04/05 = fim de semana.
describe('businessDaysBetween', () => {
  it('conta só dias úteis entre dois dias (exclusivo→inclusivo)', () => {
    expect(businessDaysBetween('2026-07-03', '2026-07-06')).toBe(1);
    expect(businessDaysBetween('2026-07-06', '2026-07-07')).toBe(1);
    expect(businessDaysBetween('2026-07-06', '2026-07-06')).toBe(0);
    expect(businessDaysBetween('2026-07-06', '2026-07-09')).toBe(3);
  });
});

describe('advanceStreak', () => {
  it('primeira entrega inicia streak = 1', () => {
    const s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    expect(s.streakDays).toBe(1);
    expect(s.lastDeliveryDay).toBe('2026-07-06');
  });

  it('mesma data não dobra; dia útil seguinte incrementa', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-06T18:00:00'));
    expect(s.streakDays).toBe(1);
    s = advanceStreak(s, new Date('2026-07-07T09:00:00'));
    expect(s.streakDays).toBe(2);
  });

  it('fim de semana NÃO quebra (sex → seg mantém)', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-03T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-06T10:00:00'));
    expect(s.streakDays).toBe(2);
  });

  it('1 dia útil perdido consome escudo e mantém; sem escudo, resseta', () => {
    let s = advanceStreak(EMPTY, new Date('2026-07-06T10:00:00'));
    s = advanceStreak(s, new Date('2026-07-08T10:00:00')); // pulou terça
    expect(s.streakDays).toBe(2);
    expect(s.shieldsUsed).toBe(1);
    s = advanceStreak(s, new Date('2026-07-13T10:00:00')); // pulou qui+sex
    expect(s.streakDays).toBe(1);
  });

  it('escudos zeram na virada do mês (2/mês)', () => {
    expect(SHIELDS_PER_MONTH).toBe(2);
    let s: StreakState = {
      streakDays: 5,
      lastDeliveryDay: '2026-07-30', // quinta
      shieldsUsedMonth: '2026-07',
      shieldsUsed: 2, // esgotados em julho
    };
    // sexta 31 pulada → gap 1 útil → escudo do MÊS NOVO cobre
    s = advanceStreak(s, new Date('2026-08-03T10:00:00')); // segunda
    expect(s.streakDays).toBe(6);
    expect(s.shieldsUsedMonth).toBe('2026-08');
    expect(s.shieldsUsed).toBe(1);
  });
});
