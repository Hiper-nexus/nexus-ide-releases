import { describe, expect, it, vi } from 'vitest';

import { WakeMic } from './wake-mic';

describe('WakeMic device restart', () => {
  it('coalesces rapid preference changes so an older restart cannot win', async () => {
    const mic = new WakeMic();
    (mic as unknown as { running: boolean }).running = true;
    const stop = vi.fn();
    const start = vi.fn(async () => {});
    Object.assign(mic, { stop, start });

    const first = mic.restartForDeviceChange();
    const latest = mic.restartForDeviceChange();
    await Promise.all([first, latest]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
