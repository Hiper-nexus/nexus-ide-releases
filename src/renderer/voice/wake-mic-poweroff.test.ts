import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeMic } from './wake-mic';

describe('WakeMic power-off', () => {
  const stopWake = vi.fn();

  beforeEach(() => {
    stopWake.mockReset();
    vi.stubGlobal('window', {
      nexus: {
        voice: {
          stopWake,
          logVoice: vi.fn(),
        },
      },
    });
  });

  it('releases main wake authority even when the local graph is already stopped', () => {
    const mic = new WakeMic();

    mic.stop();
    mic.stop();

    expect(stopWake).toHaveBeenCalledTimes(2);
  });

  it('stops the local graph before releasing main wake authority', () => {
    const mic = new WakeMic();
    const teardownGraph = vi.fn(() => {
      expect(stopWake).not.toHaveBeenCalled();
    });
    Object.assign(mic, { running: true, teardownGraph });

    mic.stop();

    expect(teardownGraph).toHaveBeenCalledOnce();
    expect(stopWake).toHaveBeenCalledOnce();
    expect(mic.isRunning()).toBe(false);
  });
});
