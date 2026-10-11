import { describe, expect, it } from 'vitest';
import { diagnoseHandoffStuck } from './handoff-stuck-diagnosis';

const NOW = 1_700_000_000_000;

describe('handoff stuck diagnosis (resto F-1040)', () => {
  it('consumed/acknowledged is not stuck', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h1', delivered: true, deliveryState: 'consumed', consumedAt: NOW },
      NOW,
    );
    expect(d.stuck).toBe(false);
    expect(d.reason).toBe('not-stuck');
  });

  it('parked after F-925 rounds asks for the operator, does not force', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h2', deliveryState: 'queued', parked: true },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'parked-needs-operator' });
    expect(d.escape).toMatch(/list-ack|Retomar/);
  });

  it('dead Maestro session points at nexus_mission_request_resume', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h3', deliveryState: 'queued', sessionAlive: false, submittedAt: NOW - 60_000 },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'session-dead' });
    expect(d.escape).toContain('nexus_mission_request_resume');
  });

  it('accepted-but-not-consumed waits for nexus_handoff_ack', () => {
    const d = diagnoseHandoffStuck(
      {
        id: 'h4',
        delivered: true,
        deliveryState: 'submitted',
        consumedAt: null,
        submittedAt: NOW - 5_000,
      },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'accepted-not-consumed' });
    expect(d.escape).toContain('nexus_handoff_ack');
  });

  it('F-1232: entrega de helper do operador sem missão não espera ACK de Maestro', () => {
    const view = {
      id: 'h4b',
      delivered: true,
      deliveryState: 'submitted',
      consumedAt: null,
      submittedAt: NOW - 21 * 24 * 3_600_000,
    };
    const workspace = diagnoseHandoffStuck({ ...view, missionId: null }, NOW);
    expect(workspace).toMatchObject({ stuck: false, reason: 'not-stuck' });
    expect(workspace.escape).not.toContain('Maestro');
    // Com missão, a semântica do ACK do Maestro não muda.
    expect(diagnoseHandoffStuck({ ...view, missionId: 'mission-a' }, NOW)).toMatchObject({
      stuck: true,
      reason: 'accepted-not-consumed',
    });
  });

  it('queued inside the acceptance window is not stuck yet', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h5', deliveryState: 'queued', submittedAt: NOW - 2_000 },
      NOW,
    );
    expect(d.stuck).toBe(false);
    expect(d.reason).toBe('waiting-acceptance-window');
  });

  it('queued past the window waits for the idle edge', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h6', deliveryState: 'queued', submittedAt: NOW - 30_000 },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'queued-awaiting-idle' });
    expect(d.escape).toMatch(/busy→idle|nexus_mission_request_resume/);
  });

  it('F-1046: ages a queued handoff from createdAt when it was never submitted', () => {
    const recent = diagnoseHandoffStuck(
      { id: 'h-recent', deliveryState: 'queued', createdAt: NOW - 2_000 },
      NOW,
    );
    expect(recent).toMatchObject({
      stuck: false,
      reason: 'waiting-acceptance-window',
    });
    const stale = diagnoseHandoffStuck(
      { id: 'h-stale', deliveryState: 'queued', createdAt: NOW - 30_000 },
      NOW,
    );
    expect(stale).toMatchObject({ stuck: true, reason: 'queued-awaiting-idle' });
  });

  it('ages a queued handoff from the last delivery attempt when that is the clock', () => {
    const d = diagnoseHandoffStuck(
      {
        id: 'h-attempt',
        deliveryState: 'queued',
        createdAt: NOW,
        attemptedAt: NOW - 30_000,
      },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'queued-awaiting-idle' });
  });

  it('retry backoff reports the round and refuses loop forcing', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h7', deliveryState: 'queued', retryRound: 3, submittedAt: NOW - 120_000 },
      NOW,
    );
    expect(d).toMatchObject({ stuck: true, reason: 'retry-backoff' });
    expect(d.summary).toContain('rodada 3');
    expect(d.escape).toMatch(/busy→idle/);
  });
  it('F-1064: a persisted paste deadline overrides the reservation-age heuristic', () => {
    const view = { id: 'h-deadline', deliveryState: 'queued', attemptedAt: NOW - 13_000,
      deliveryAttemptState: 'pasted', acceptDeadlineAt: NOW + 20_000 };
    expect(diagnoseHandoffStuck(view, NOW)).toMatchObject({ stuck: false, reason: 'waiting-acceptance-window' });
    expect(diagnoseHandoffStuck({ ...view, attemptedAt: NOW, acceptDeadlineAt: NOW - 1 }, NOW))
      .toMatchObject({ stuck: true, reason: 'queued-awaiting-idle' });
  });

  it('F-1064: a reservation does not pretend the paste acceptance clock has started', () => {
    expect(diagnoseHandoffStuck({ id: 'h-reserved', deliveryState: 'queued',
      attemptedAt: NOW - 30_000, deliveryAttemptState: 'reserved' }, NOW))
      .toMatchObject({ stuck: false, reason: 'waiting-paste-start' });
  });

});
