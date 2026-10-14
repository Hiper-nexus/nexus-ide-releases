import { beforeEach, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
vi.mock('./main-trace', () => ({ trace: emit }));
import { beginBootPhases, markBootPhase, startBootStep, finishBootStep } from './boot-phases';

beforeEach(() => { emit.mockReset(); });

it('emits one boot event with milestones and only steps over 20ms, including failed steps', () => {
  const now = vi.spyOn(performance, 'now');
  now.mockReturnValue(100);
  beginBootPhases();
  markBootPhase('whenReady');
  markBootPhase('window-created');
  const short = startBootStep();
  now.mockReturnValue(120);
  finishBootStep('short', short);
  const slow = startBootStep();
  now.mockReturnValue(151);
  finishBootStep('slow', slow);
  markBootPhase('path-resolved');
  markBootPhase('bootstrap-ready');
  markBootPhase('renderer-load-start');
  markBootPhase('did-finish-load');
  expect(emit).not.toHaveBeenCalled();
  markBootPhase('mount');
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    kind: 'boot-phases', startedAt: performance.timeOrigin,
    phases: { whenReady: 100, 'window-created': 100, 'path-resolved': 151,
      'bootstrap-ready': 151, 'renderer-load-start': 151, 'did-finish-load': 151, mount: 151 },
    slowSteps: [{ step: 'slow', startMs: 120, durationMs: 31 }],
  });
  now.mockRestore();
});

it('handles mount arriving before did-finish-load and has no clocks or traces after boot', () => {
  beginBootPhases();
  markBootPhase('mount');
  expect(emit).not.toHaveBeenCalled();
  markBootPhase('did-finish-load');
  expect(emit).toHaveBeenCalledTimes(1);
  const now = vi.spyOn(performance, 'now');
  markBootPhase('mount');
  markBootPhase('renderer-load-start');
  finishBootStep('post-boot', startBootStep());
  expect(now).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledTimes(1);
  now.mockRestore();
});
