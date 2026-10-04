import { describe, expect, it } from 'vitest';
import { SOAK_POLICY, assertSoakSamples, parseSoakCycle, type SoakSample } from './soak-smoke';

import { soakSamples as samples, soakCycle as cycle } from './__tests__/soak-fixture';

describe('five minute activity acceptance policy', () => {
  it('accepts sustained real activity samples with bounded memory', () => {
    expect(SOAK_POLICY.requiredDurationMs).toBe(300000);
    expect(assertSoakSamples(samples(), 301000).mainHeap.growthBytes).toBe(0);
  });
  it.each(['short', 'idle-gap', 'missing', 'zero', 'false-close', 'growth', 'wrong-pid', 'host-leak'])('rejects %s rather than treating it as five minutes of use', kind => {
    const values = samples();
    if (kind === 'short') values.pop();
    if (kind === 'idle-gap') values[20]!.elapsedMs += 16000;
    if (kind === 'missing') delete (values[10]!.memoryBytes as Partial<SoakSample['memoryBytes']>).rendererHeap;
    if (kind === 'zero') values[10]!.memoryBytes.paneRss = 0;
    if (kind === 'false-close') values[10]!.activity.physicalClose = false as true;
    if (kind === 'growth') for (let i = 30; i < values.length; i++) values[i]!.memoryBytes.mainHeap += 100e6;
    if (kind === 'wrong-pid') values[10]!.rendererPid++;
    if (kind === 'host-leak') values[10]!.rendererHosts = 4;
    expect(() => assertSoakSamples(values, 301000)).toThrow();
  });
  it('requires the exact bounded renderer protocol and the pinned heap source', () => {
    expect(parseSoakCycle(cycle())).not.toBeNull();
    for (const alter of [(v: ReturnType<typeof cycle>) => { v.heapUsedKiB = 0; }, (v: ReturnType<typeof cycle>) => { v.electronVersion = '42.0.0'; }, (v: ReturnType<typeof cycle>) => { v.activity.frames = 1; }]) {
      const value = cycle(); alter(value); expect(parseSoakCycle(value)).toBeNull();
    }
    expect(parseSoakCycle({ ...cycle(), unexpected: 'field' })).toBeNull();
  });
});
