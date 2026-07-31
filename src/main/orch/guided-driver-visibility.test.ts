import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';

const emitDriverDecision = vi.hoisted(() => vi.fn(() => true));

vi.mock('./mission-event-emit', () => ({
  emitDriverDecision,
}));

import {
  resetGuidedDeliveryDriverInactiveWarnings,
  warnGuidedDeliveryDriverInactive,
} from './guided-driver-visibility';

const scope = testProjectScope({ checkoutId: 'guided-driver-visibility' });

describe('guided delivery driver-inactive warning', () => {
  beforeEach(() => {
    resetGuidedDeliveryDriverInactiveWarnings();
    emitDriverDecision.mockClear();
    vi.restoreAllMocks();
  });

  it('warns loudly once per mission, on console and on the mission journal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnGuidedDeliveryDriverInactive(scope, 'mission-a');
    warnGuidedDeliveryDriverInactive(scope, 'mission-a');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/mission driver desativado/i);
    expect(warn.mock.calls[0]?.[0]).toContain('mission=mission-a');
    expect(emitDriverDecision).toHaveBeenCalledTimes(1);
    expect(emitDriverDecision).toHaveBeenCalledWith(
      scope,
      'mission-a',
      'driver_inactive_guided_delivery',
      expect.stringMatching(/missionDriverActiveMode/),
      'shadow',
      'driver-inactive',
    );
  });

  it('warns again for a different mission', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnGuidedDeliveryDriverInactive(scope, 'mission-a');
    warnGuidedDeliveryDriverInactive(scope, 'mission-b');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(emitDriverDecision).toHaveBeenCalledTimes(2);
  });
});
