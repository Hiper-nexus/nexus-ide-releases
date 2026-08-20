import { describe, expect, it } from 'vitest';
import {
  clampRouteReservationTtlMs,
  ROUTE_RESERVATION_TTL_MAX_MS,
  ROUTE_RESERVATION_TTL_MIN_MS,
  ROUTE_RESERVATION_TTL_MS,
} from './mission-route-reservation-ledger';

describe('TTL da reserva de rota', () => {
  it('o default respeita o teto do schema — regressão do brick de 20/08', () => {
    // b34907b3 pôs teto de 30min no schema com default de 60min: TODO
    // nexus_route_task falhava ("too_big, maximum 1800000", path vazio) e a
    // missão ficava presa em route_reservation_required para sempre.
    expect(ROUTE_RESERVATION_TTL_MS).toBeLessThanOrEqual(
      ROUTE_RESERVATION_TTL_MAX_MS,
    );
    expect(ROUTE_RESERVATION_TTL_MS).toBeGreaterThanOrEqual(
      ROUTE_RESERVATION_TTL_MIN_MS,
    );
  });

  it('clamp: pedido acima do teto vira o teto, nunca erro', () => {
    expect(clampRouteReservationTtlMs(60 * 60_000)).toBe(
      ROUTE_RESERVATION_TTL_MAX_MS,
    );
  });

  it('clamp: pedido abaixo do piso vira o piso', () => {
    expect(clampRouteReservationTtlMs(10)).toBe(ROUTE_RESERVATION_TTL_MIN_MS);
  });

  it('clamp: float arredonda, NaN/Infinity caem no teto', () => {
    expect(clampRouteReservationTtlMs(5_000.7)).toBe(5_001);
    expect(clampRouteReservationTtlMs(Number.NaN)).toBe(
      ROUTE_RESERVATION_TTL_MAX_MS,
    );
    expect(clampRouteReservationTtlMs(Number.POSITIVE_INFINITY)).toBe(
      ROUTE_RESERVATION_TTL_MAX_MS,
    );
  });

  it('clamp: valor dentro da faixa passa intacto', () => {
    expect(clampRouteReservationTtlMs(120_000)).toBe(120_000);
  });
});
