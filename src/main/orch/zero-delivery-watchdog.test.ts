import { describe, expect, it } from 'vitest';
import {
  decideZeroDeliveryWatchdog,
  ZERO_DELIVERY_ESCALATE_MS,
  ZERO_DELIVERY_POKE_MS,
} from './zero-delivery-watchdog';

describe('zero-delivery watchdog', () => {
  const base = {
    missionStatus: 'running',
    lane: 'standard' as string | null,
    workerPanes: 1,
    workerHandoffCount: 0,
    orchestratorState: 'idle' as string | null,
    executingSinceMs: 1_000,
    now: 1_000,
    alreadyPoked: false,
  };

  it('não age antes do orçamento de poke', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        now: base.executingSinceMs! + ZERO_DELIVERY_POKE_MS - 1,
      }),
    ).toEqual({ action: 'none' });
  });

  it('poke quando executing + 0 handoffs + Maestro idle após 3min', () => {
    const decision = decideZeroDeliveryWatchdog({
      ...base,
      now: base.executingSinceMs! + ZERO_DELIVERY_POKE_MS,
    });
    expect(decision.action).toBe('poke');
  });

  it('escalate após poke + 8min sem entrega', () => {
    const decision = decideZeroDeliveryWatchdog({
      ...base,
      alreadyPoked: true,
      now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
    });
    expect(decision.action).toBe('escalate');
  });

  it('não interrompe Maestro busy e ignora plan/consult', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        orchestratorState: 'busy',
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        lane: 'plan',
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
  });

  it('silencia quando já houve handoff de worker', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        workerHandoffCount: 1,
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
  });
});
