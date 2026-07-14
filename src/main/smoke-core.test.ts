import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  captureSmokeTestMode,
  createSmokeSettler,
  gracefulSmokeExit,
  isSmokeTest,
  shouldAccessSecureStorage,
  shouldInitializeManagedAgentHooks,
  shouldInitializeAutoUpdater,
  shouldRequestMicrophoneAccess,
  shouldUseUserDataOverride,
  SMOKE_ARGUMENT,
  SMOKE_FLAG,
  smokeExitCode,
} from './smoke-core';

describe('isSmokeTest', () => {
  it('detects the flag anywhere in argv', () => {
    expect(isSmokeTest(['/path/electron', SMOKE_FLAG])).toBe(true);
    expect(isSmokeTest(['/path/electron', '--other', SMOKE_FLAG, 'x'])).toBe(true);
  });

  it('detects the positional packaged-smoke sentinel', () => {
    expect(isSmokeTest(['/path/NexusIDE', SMOKE_ARGUMENT])).toBe(true);
  });

  it('returns false without the flag', () => {
    expect(isSmokeTest(['/path/electron'])).toBe(false);
    expect(isSmokeTest([])).toBe(false);
  });

  it('does not match partial or prefixed flags', () => {
    expect(isSmokeTest(['--smoke-test=1'])).toBe(false);
    expect(isSmokeTest(['--smoke'])).toBe(false);
    expect(isSmokeTest(['nexus-smoke-test-extra'])).toBe(false);
  });

  it('keeps launch-time smoke mode after Electron rewrites process argv', () => {
    const argv = ['/path/NexusIDE', SMOKE_ARGUMENT];
    const isCapturedSmokeTest = captureSmokeTestMode(argv);

    argv.splice(1);

    expect(isSmokeTest(argv)).toBe(false);
    expect(isCapturedSmokeTest()).toBe(true);
  });
});

describe('smokeExitCode', () => {
  it('maps functional-ready to success', () => {
    expect(smokeExitCode('functional-ready')).toBe(0);
  });

  it('maps every failure event to 1', () => {
    expect(smokeExitCode('functional-failed')).toBe(1);
    expect(smokeExitCode('renderer-failed')).toBe(1);
    expect(smokeExitCode('uncaught-exception')).toBe(1);
    expect(smokeExitCode('timeout')).toBe(1);
  });
});

describe('gracefulSmokeExit', () => {
  it('sets the result before requesting normal Electron shutdown', () => {
    const events: string[] = [];

    gracefulSmokeExit(1, {
      setExitCode: (code) => events.push(`code:${code}`),
      quit: () => events.push('quit'),
    });

    expect(events).toEqual(['code:1', 'quit']);
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

describe('smoke isolation', () => {
  it('never reads the real OS secret store during a smoke test', () => {
    expect(shouldAccessSecureStorage(['/path/NexusIDE', SMOKE_FLAG])).toBe(false);
    expect(shouldAccessSecureStorage(['/path/NexusIDE'])).toBe(true);
  });

  it('does not open a macOS microphone permission prompt during a smoke test', () => {
    expect(shouldRequestMicrophoneAccess('darwin', ['/path/NexusIDE', SMOKE_FLAG])).toBe(false);
    expect(shouldRequestMicrophoneAccess('darwin', ['/path/NexusIDE'])).toBe(true);
    expect(shouldRequestMicrophoneAccess('linux', ['/path/NexusIDE'])).toBe(false);
  });

  it('does not contact an update source during a smoke test', () => {
    expect(shouldInitializeAutoUpdater(['/path/NexusIDE', SMOKE_ARGUMENT])).toBe(false);
    expect(shouldInitializeAutoUpdater(['/path/NexusIDE'])).toBe(true);
  });

  it('does not block packaged smoke on managed-hook consent', () => {
    expect(shouldInitializeManagedAgentHooks(['/path/NexusIDE', SMOKE_ARGUMENT])).toBe(false);
    expect(shouldInitializeManagedAgentHooks(['/path/NexusIDE', SMOKE_FLAG])).toBe(false);
    expect(shouldInitializeManagedAgentHooks(['/path/NexusIDE'])).toBe(true);
  });

  it('keeps the hook server and consent dialog behind the smoke guard in main', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const hookSection = mainSource.indexOf('// Gap A:');
    const guardStart = mainSource.indexOf('if (!isCurrentProcessSmokeTest()) {', hookSection);
    const guardEnd = mainSource.indexOf('// Gap B:', guardStart);
    const guardedBlock = mainSource.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(guardedBlock).toContain('await startAgentHookHttpServer');
    expect(guardedBlock).toContain('resolveManagedHookConsent');
  });

  it('bootstraps the desktop window before optional hooks can delay launch', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const readyStart = mainSource.indexOf('app.whenReady().then(async () => {');
    const hookSection = mainSource.indexOf('// Gap A:', readyStart);
    const createWindowAtReady = mainSource.indexOf('    createMainWindow();', readyStart);
    const bootstrapBeforeHooks = mainSource.indexOf('    bootstrap();', readyStart);

    expect(readyStart).toBeGreaterThan(-1);
    expect(hookSection).toBeGreaterThan(readyStart);
    expect(createWindowAtReady).toBeGreaterThan(readyStart);
    expect(createWindowAtReady).toBeLessThan(bootstrapBeforeHooks);
    expect(bootstrapBeforeHooks).toBeGreaterThan(readyStart);
    expect(bootstrapBeforeHooks).toBeLessThan(hookSection);
  });
});

describe('createSmokeSettler', () => {
  it('exits 0 only after the functional probes pass', () => {
    const exit = vi.fn();
    const settle = createSmokeSettler(exit, vi.fn());

    settle('functional-ready');

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

    settle('functional-ready');
    settle('timeout', 'late');
    settle('uncaught-exception', 'later still');

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs success events as non-error', () => {
    const log = vi.fn();
    const settle = createSmokeSettler(vi.fn(), log);

    settle('functional-ready');

    expect(log).toHaveBeenCalledExactlyOnceWith('[smoke] functional-ready', false);
  });
});
