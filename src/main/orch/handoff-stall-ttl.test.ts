import { describe, expect, it } from 'vitest';
import {
  HANDOFF_STALL_TTL_MS,
  findStalledHandoffIds,
  type StallCandidate,
} from './handoff-stall-ttl';

function handoff(
  overrides: Partial<StallCandidate> = {},
): StallCandidate {
  return {
    id: 'h-1',
    status: 'progress',
    deliveryState: 'submitted',
    createdAt: 0,
    ...overrides,
  };
}

describe('findStalledHandoffIds', () => {
  it('entrega em voo sem veredito além do TTL vira stalled', () => {
    expect(
      findStalledHandoffIds([handoff()], HANDOFF_STALL_TTL_MS + 1),
    ).toEqual(['h-1']);
  });

  it('dentro do TTL ainda é espera legítima', () => {
    expect(findStalledHandoffIds([handoff()], HANDOFF_STALL_TTL_MS - 1)).toEqual(
      [],
    );
  });

  it('veredito terminal ou já-stalled nunca re-marca', () => {
    expect(
      findStalledHandoffIds(
        [
          handoff({ id: 'a', status: 'success' }),
          handoff({ id: 'b', status: 'stalled' }),
          handoff({ id: 'c', status: 'failed' }),
        ],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual([]);
  });

  it('consumed/acknowledged não são voo', () => {
    expect(
      findStalledHandoffIds(
        [
          handoff({ id: 'a', deliveryState: 'consumed' }),
          handoff({ id: 'b', deliveryState: 'acknowledged' }),
        ],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual([]);
  });
});
