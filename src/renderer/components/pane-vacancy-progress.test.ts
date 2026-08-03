import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_PROGRESS_STEPS,
  type BootstrapProgressStep,
} from '../../shared/mission-intent-projection';
import {
  bootstrapStepLabel,
  latestBootstrapProgress,
  progressAgeLabel,
} from './pane-vacancy-progress';

function journalEvent(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence: 1,
    id: 'evt-1',
    missionId: 'mission-1',
    runId: 'bootstrap-mission-1',
    type: 'custom',
    payload: { kind: 'bootstrap_progress', step: 'plan_baseline' },
    idempotencyKey: 'bootstrap:mission-1:plan_baseline:1',
    occurredAt: 1_000,
    origin: 'main',
    deliveryStatus: 'pending',
    ...patch,
  };
}

describe('bootstrapStepLabel — PT-BR copy for every step', () => {
  it('labels every known step with non-empty text', () => {
    for (const step of BOOTSTRAP_PROGRESS_STEPS) {
      const label = bootstrapStepLabel(step);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('progressAgeLabel — age that never lies', () => {
  it('renders seconds under a minute', () => {
    expect(progressAgeLabel(1_000, 13_000)).toBe('há 12s');
  });

  it('renders minutes from one minute on', () => {
    expect(progressAgeLabel(0, 90_000)).toBe('há 1 min');
    expect(progressAgeLabel(0, 200_000)).toBe('há 3 min');
  });

  it('clamps clock skew to zero instead of a negative age', () => {
    expect(progressAgeLabel(5_000, 1_000)).toBe('há 0s');
  });
});

describe('latestBootstrapProgress — defensive journal parsing', () => {
  it('returns null for an empty page', () => {
    expect(latestBootstrapProgress([], 'mission-1')).toBeNull();
  });

  it('picks the highest-sequence progress event', () => {
    const latest = latestBootstrapProgress(
      [
        journalEvent({ sequence: 2, occurredAt: 2_000 }),
        journalEvent({
          sequence: 7,
          occurredAt: 7_000,
          payload: { kind: 'bootstrap_progress', step: 'pane_spawned' },
        }),
        journalEvent({ sequence: 5, occurredAt: 5_000 }),
      ],
      'mission-1',
    );
    expect(latest).toEqual({
      missionId: 'mission-1',
      step: 'pane_spawned',
      occurredAt: 7_000,
    });
  });

  it('ignores events of another mission', () => {
    expect(
      latestBootstrapProgress(
        [journalEvent({ missionId: 'mission-2' })],
        'mission-1',
      ),
    ).toBeNull();
  });

  it('ignores journal events that are not bootstrap progress', () => {
    expect(
      latestBootstrapProgress(
        [journalEvent({ payload: { kind: 'something_else', step: 'x' } })],
        'mission-1',
      ),
    ).toBeNull();
  });

  it('drops unknown step names instead of rendering them raw', () => {
    expect(
      latestBootstrapProgress(
        [journalEvent({ payload: { kind: 'bootstrap_progress', step: 'nope' } })],
        'mission-1',
      ),
    ).toBeNull();
  });

  it('survives garbage entries in the page', () => {
    const latest = latestBootstrapProgress(
      [null, 42, 'junk', journalEvent({ payload: null }), journalEvent()],
      'mission-1',
    );
    expect(latest?.step).toBe('plan_baseline' satisfies BootstrapProgressStep);
  });
});
