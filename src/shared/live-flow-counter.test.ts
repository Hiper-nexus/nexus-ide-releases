import { describe, expect, it } from 'vitest';
import { ThrottledCounter } from './live-flow-counter';

describe('ThrottledCounter', () => {
  it('fires on the very first tick (immediate proof of flow)', () => {
    const c = new ThrottledCounter(25, 2_000);
    const t = c.tick(0);
    expect(t.fire).toBe(true);
    expect(t.count).toBe(1);
  });

  it('throttles by count: fires every N ticks', () => {
    const c = new ThrottledCounter(25, 10_000);
    c.tick(0); // first fires
    let fires = 0;
    for (let i = 1; i < 60; i += 1) {
      // hold time constant so only the N-throttle can fire
      if (c.tick(0).fire) fires += 1;
    }
    // ticks 26 (25 after the first) and 51 fire → 2 more
    expect(fires).toBe(2);
    expect(c.total).toBe(60);
  });

  it('throttles by time: fires once the window elapses even below N', () => {
    const c = new ThrottledCounter(1_000, 2_000);
    c.tick(0); // first fires, lastLoggedAt=0
    expect(c.tick(1_999).fire).toBe(false);
    expect(c.tick(2_000).fire).toBe(true);
  });

  it('reset() clears the session so the next tick fires again as first', () => {
    const c = new ThrottledCounter(25, 2_000);
    c.tick(0);
    c.tick(0);
    c.reset();
    expect(c.total).toBe(0);
    expect(c.tick(0).fire).toBe(true);
  });

  it('a mute session leaves a signature: mic ticks but server-audio stays zero', () => {
    const mic = new ThrottledCounter(25, 2_000);
    const serverAudio = new ThrottledCounter(25, 2_000);
    for (let i = 0; i < 40; i += 1) mic.tick(i * 20);
    // provider sent nothing back
    expect(mic.total).toBeGreaterThan(0);
    expect(serverAudio.total).toBe(0);
  });
});
