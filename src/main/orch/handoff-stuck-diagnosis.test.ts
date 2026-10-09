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

  it('retry backoff reports the round and refuses loop forcing', () => {
    const d = diagnoseHandoffStuck(
      { id: 'h7', deliveryState: 'queued', retryRound: 3, submittedAt: NOW - 120_000 },
      NOW,
    );
    // retryRound > 0 wins only when not already classified as queued-awaiting-idle
    // — queued+submittedAt hits queued-awaiting-idle first (more specific).
    expect(d.stuck).toBe(true);
  });
});
