/**
 * Shipping streak com misericórdia: conta DIAS ÚTEIS (fim de semana nunca
 * quebra) e dá 2 escudos/mês — um dia útil perdido consome escudo em vez de
 * zerar (férias/imprevistos não viram punição). Puro e determinístico.
 */

export const SHIELDS_PER_MONTH = 2;

export interface StreakState {
  streakDays: number;
  /** Último dia com entrega, `YYYY-MM-DD` local. */
  lastDeliveryDay: string | null;
  /** Mês (`YYYY-MM`) a que se refere o contador de escudos. */
  shieldsUsedMonth: string | null;
  shieldsUsed: number;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthKey(day: string): string {
  return day.slice(0, 7);
}

function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

/** Dias ÚTEIS no intervalo (fromDay, toDay] — exclusivo no início. */
export function businessDaysBetween(fromDay: string, toDay: string): number {
  const cursor = new Date(`${fromDay}T12:00:00`);
  const end = new Date(`${toDay}T12:00:00`);
  let count = 0;
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor <= end && isBusinessDay(cursor)) count += 1;
  }
  return count;
}

export function advanceStreak(
  state: StreakState,
  deliveryDate: Date,
): StreakState {
  const today = dayKey(deliveryDate);
  const month = monthKey(today);
  // Vira o mês → zera o contador de escudos.
  const shieldsUsed = state.shieldsUsedMonth === month ? state.shieldsUsed : 0;

  if (!state.lastDeliveryDay) {
    return { streakDays: 1, lastDeliveryDay: today, shieldsUsedMonth: month, shieldsUsed };
  }
  if (state.lastDeliveryDay === today) {
    return { ...state, shieldsUsedMonth: month, shieldsUsed };
  }

  const gap = businessDaysBetween(state.lastDeliveryDay, today);
  const missed = Math.max(0, gap - 1); // hoje conta 1; perdidos = gap - 1
  if (missed === 0) {
    return {
      streakDays: state.streakDays + 1,
      lastDeliveryDay: today,
      shieldsUsedMonth: month,
      shieldsUsed,
    };
  }
  const shieldsLeft = SHIELDS_PER_MONTH - shieldsUsed;
  if (missed <= shieldsLeft) {
    return {
      streakDays: state.streakDays + 1,
      lastDeliveryDay: today,
      shieldsUsedMonth: month,
      shieldsUsed: shieldsUsed + missed,
    };
  }
  return { streakDays: 1, lastDeliveryDay: today, shieldsUsedMonth: month, shieldsUsed };
}
