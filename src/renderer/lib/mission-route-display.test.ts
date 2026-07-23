import { describe, expect, it } from 'vitest';
import type { MissionRouteTrace } from '../../shared/orch-types';
import { missionRouteDisplay } from './mission-route-display';

const TRACE: MissionRouteTrace = {
  reservationId: 'route-1',
  taskPreview: 'corrigir golden path',
  tier: 'critical',
  adapterId: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  reason: 'diversidade crítica com modelo real do CLI',
  state: 'consumed',
  createdAt: 1,
  expiresAt: 2,
  consumedAt: 2,
  consumedBySession: 'dispatch-secret-session',
};

describe('mission route display', () => {
  it('makes the durable route visible without exposing the consumer bearer/session', () => {
    const display = missionRouteDisplay(TRACE);
    expect(display?.meta).toBe('rota codex/gpt-5.6-sol · crítica · usada');
    expect(display?.title).toContain('diversidade crítica');
    expect(display?.title).toContain('corrigir golden path');
    expect(display?.title).not.toContain('dispatch-secret-session');
  });

  it('labels reserved and expired decisions honestly', () => {
    expect(missionRouteDisplay({ ...TRACE, state: 'reserved' })?.meta).toContain(
      'reservada',
    );
    expect(missionRouteDisplay({ ...TRACE, state: 'expired' })?.meta).toContain(
      'expirada',
    );
  });

  it('returns null before the motor has made a route decision', () => {
    expect(missionRouteDisplay(undefined)).toBeNull();
  });
});
