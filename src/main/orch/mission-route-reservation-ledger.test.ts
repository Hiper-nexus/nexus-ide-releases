import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
beforeEach(resetLicensedAccessMock);
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ScopedMissionStore } from './mission-store';
import { GLOBAL_USE_WINDOW_MS } from './task-router';
import { testProjectScope } from './__tests__/scope-fixture';
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

// F-232: o fair-share global lê as reservas CONSUMIDAS na janela de 7 dias —
// só consumidas contam, e só dentro da janela.
describe('consumedCountsByAdapterSince (fair-share global)', () => {
  const testDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-route-ledger-fairshare-'),
  );
  const scope = testProjectScope({ rootRealPath: testDir });
  const runtime = new ProjectRuntimeManager({
    baseDir: path.join(testDir, 'runtime'),
    appVersion: 'route-ledger-fairshare-test',
  });
  const store = new ScopedMissionStore(runtime, scope);
  const missionId = store.create({
    title: 'Contar reservas consumidas',
    intentState: 'dispatched',
    intentVersion: 1,
    orchestratorSessionId: 'orch-session',
  }).id;
  store.setStatus(missionId, 'running');

  afterAll(() => {
    runtime.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const reserve = (adapterId: string, model: string, task: string) =>
    store.reserveRouteDecision(missionId, task, {
      tier: 'medium',
      adapterId,
      model,
      reason: 'teste',
      alternatives: [],
    });

  it('conta só reservas consumidas dentro da janela, agrupadas por adapter', () => {
    const glmA = reserve('glm', 'glm-5.3', 'primeira reserva glm');
    const glmB = reserve('glm', 'glm-5.3', 'segunda reserva glm');
    const muse = reserve('muse', 'muse-spark-1.3', 'reserva muse');
    // Reserva aberta (não consumida) NÃO conta.
    reserve('kimi', 'kimi-code/k3', 'reserva kimi ainda aberta');
    // Consumida fora da janela (8 dias) NÃO conta — inserida direto porque a
    // API pública não permite consumed_at antigo (TTL máx. 30min).
    const old = reserve('codex', 'gpt-6.1-sol', 'reserva codex antiga');
    const oldConsumedAt = Date.now() - GLOBAL_USE_WINDOW_MS - 60_000;
    // CHECK: consumed_at >= created_at — a linha antiga precisa nascer velha.
    runtime
      .open(scope)
      .db.prepare(
        `UPDATE mission_route_reservations
         SET created_at = ?, expires_at = ?, consumed_at = ?, consumed_by_session = ?
         WHERE id = ?`,
      )
      .run(
        oldConsumedAt - 60_000,
        oldConsumedAt + 60_000,
        oldConsumedAt,
        'sess-velha',
        old.id,
      );

    store.consumeRouteReservation(
      {
        reservationId: glmA.id,
        missionId,
        adapterId: 'glm',
        model: 'glm-5.3',
      },
      'sess-1',
    );
    store.consumeRouteReservation(
      {
        reservationId: glmB.id,
        missionId,
        adapterId: 'glm',
        model: 'glm-5.3',
      },
      'sess-2',
    );
    store.consumeRouteReservation(
      {
        reservationId: muse.id,
        missionId,
        adapterId: 'muse',
        model: 'muse-spark-1.3',
      },
      'sess-3',
    );

    expect(
      store.consumedRouteCountsByAdapterSince(
        Date.now() - GLOBAL_USE_WINDOW_MS,
      ),
    ).toEqual(new Map([['glm', 2], ['muse', 1]]));
  });
});
