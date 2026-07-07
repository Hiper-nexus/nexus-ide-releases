import { describe, expect, it, vi } from 'vitest';

import {
  createSmokeSettler,
  isSmokeTest,
  shouldUseUserDataOverride,
  SMOKE_FLAG,
  smokeExitCode,
} from './smoke-core';

describe('isSmokeTest', () => {
  it('detects the flag anywhere in argv', () => {
    expect(isSmokeTest(['/path/electron', SMOKE_FLAG])).toBe(true);
    expect(isSmokeTest(['/path/electron', '--other', SMOKE_FLAG, 'x'])).toBe(true);
  });

  it('returns false without the flag', () => {
    expect(isSmokeTest(['/path/electron'])).toBe(false);
    expect(isSmokeTest([])).toBe(false);
  });

  it('does not match partial or prefixed flags', () => {
    expect(isSmokeTest(['--smoke-test=1'])).toBe(false);
    expect(isSmokeTest(['--smoke'])).toBe(false);
  });
});

describe('smokeExitCode', () => {
  it('maps renderer-loaded to success', () => {
    expect(smokeExitCode('renderer-loaded')).toBe(0);
  });

  it('maps every failure event to 1', () => {
    expect(smokeExitCode('renderer-failed')).toBe(1);
    expect(smokeExitCode('uncaught-exception')).toBe(1);
    expect(smokeExitCode('timeout')).toBe(1);
  });
});

describe('shouldUseUserDataOverride', () => {
  it('keeps the dev override behavior for unpackaged runs', () => {
    expect(shouldUseUserDataOverride(false, ['/path/electron'], '/tmp/nexus')).toBe(true);
  });

  it('allows isolated userData for packaged smoke tests', () => {
    expect(
      shouldUseUserDataOverride(true, ['/Applications/NexusIDE.app/Contents/MacOS/NexusIDE', SMOKE_FLAG], '/tmp/nexus'),
    ).toBe(true);
  });

  it('ignores the override for normal packaged launches', () => {
    expect(
      shouldUseUserDataOverride(true, ['/Applications/NexusIDE.app/Contents/MacOS/NexusIDE'], '/tmp/nexus'),
    ).toBe(false);
  });

  it('ignores empty overrides', () => {
    expect(shouldUseUserDataOverride(false, ['/path/electron'], undefined)).toBe(false);
  });
});

describe('createSmokeSettler', () => {
  it('exits 0 when the renderer loads', () => {
    const exit = vi.fn();
    const settle = createSmokeSettler(exit, vi.fn());

    settle('renderer-loaded');

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits 1 on failure events with the detail in the log line', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const settle = createSmokeSettler(exit, log);

    settle('uncaught-exception', 'TypeError: kaboom');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).toHaveBeenCalledExactlyOnceWith('[smoke] uncaught-exception: TypeError: kaboom', true);
  });

  it('only the first event settles — later events are ignored', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const settle = createSmokeSettler(exit, log);

    settle('renderer-loaded');
    settle('timeout', 'late');
    settle('uncaught-exception', 'later still');

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs success events as non-error', () => {
    const log = vi.fn();
    const settle = createSmokeSettler(vi.fn(), log);

    settle('renderer-loaded');

    expect(log).toHaveBeenCalledExactlyOnceWith('[smoke] renderer-loaded', false);
  });
});
