import { describe, expect, it } from 'vitest';
import type fs from 'node:fs';
import {
  assertSafeEnvName,
  assertSafeUiKitArgs,
  assertSafeUiKitCwd,
  buildUiKitChildEnv,
  resolveNpxCommand,
  UiKitCliError,
  UI_KIT_MAX_ARGS,
  UI_KIT_PACKAGES,
} from './ui-kit-cli';

function statsFor(kind: 'dir' | 'file' | 'symlink'): fs.Stats {
  return {
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  } as fs.Stats;
}

describe('buildUiKitChildEnv', () => {
  it('forwards only allowlisted keys and never a provider secret', () => {
    const env = buildUiKitChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      ANTHROPIC_API_KEY: 'sk-should-not-travel',
      OPENAI_API_KEY: 'sk-nope',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/op');
    expect(env.npm_config_yes).toBe('true');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('adds a validated registry token', () => {
    const env = buildUiKitChildEnv({ PATH: '/usr/bin' }, { REGISTRY_TOKEN: 't0ken' });

    expect(env.REGISTRY_TOKEN).toBe('t0ken');
  });

  it('refuses a lowercase or malformed registry env name', () => {
    expect(() => buildUiKitChildEnv({}, { registry_token: 'x' })).toThrow(UiKitCliError);
    expect(() => buildUiKitChildEnv({}, { 'A-B': 'x' })).toThrow(UiKitCliError);
  });

  it('refuses to let a caller override PATH or the npm registry', () => {
    expect(() => assertSafeEnvName('PATH')).toThrow(/cannot be overridden/);
    expect(() => assertSafeEnvName('NPM_CONFIG_REGISTRY')).toThrow(/cannot be overridden/);
  });

  it('never puts a token value in the error message', () => {
    try {
      buildUiKitChildEnv({}, { REGISTRY_TOKEN: 'super\nsecret' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).toContain('REGISTRY_TOKEN');
      expect(String(error)).not.toContain('super');
    }
  });
});

describe('assertSafeUiKitArgs', () => {
  it('accepts a normal add argv', () => {
    expect(assertSafeUiKitArgs(['add', 'button', '--yes'])).toHaveLength(3);
  });

  it('refuses a NUL or newline smuggled into an argument', () => {
    expect(() => assertSafeUiKitArgs(['add', 'button\nrm -rf /'])).toThrow(UiKitCliError);
    expect(() => assertSafeUiKitArgs(['add', 'button\0'])).toThrow(UiKitCliError);
  });

  it('caps the argument count', () => {
    const many = Array.from({ length: UI_KIT_MAX_ARGS + 1 }, () => 'button');
    expect(() => assertSafeUiKitArgs(many)).toThrow(/at most/);
  });
});

describe('assertSafeUiKitCwd', () => {
  it('refuses a relative directory', () => {
    expect(() => assertSafeUiKitCwd('relative/path')).toThrow(/absolute/);
  });

  it('accepts a read-only run without touching node_modules', () => {
    let lstatCalls = 0;
    const cwd = assertSafeUiKitCwd('/projects/app', {
      statSync: () => statsFor('dir'),
      lstatSync: () => {
        lstatCalls += 1;
        return statsFor('dir');
      },
    });

    expect(cwd).toBe('/projects/app');
    expect(lstatCalls).toBe(0);
  });

  it('refuses a writing run when node_modules is a symlink', () => {
    expect(() =>
      assertSafeUiKitCwd('/worktrees/feature', {
        writes: true,
        statSync: () => statsFor('dir'),
        lstatSync: () => statsFor('symlink'),
      }),
    ).toThrow(/node_modules is a symlink/);
  });

  it('allows a writing run when node_modules is a real directory', () => {
    expect(
      assertSafeUiKitCwd('/projects/app', {
        writes: true,
        statSync: () => statsFor('dir'),
        lstatSync: () => statsFor('dir'),
      }),
    ).toBe('/projects/app');
  });

  it('allows a writing run before the first install', () => {
    expect(
      assertSafeUiKitCwd('/projects/fresh', {
        writes: true,
        statSync: () => statsFor('dir'),
        lstatSync: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBe('/projects/fresh');
  });
});

describe('resolveNpxCommand', () => {
  it('is a bare npx off win32', () => {
    expect(resolveNpxCommand({ platform: 'darwin' })).toBe('npx');
  });

  it('finds npx.cmd on PATH on win32', () => {
    const resolved = resolveNpxCommand({
      platform: 'win32',
      pathString: 'C:\\nodejs;C:\\other',
      exists: (candidate) => candidate === 'C:\\nodejs\\npx.cmd',
    });

    expect(resolved).toBe('C:\\nodejs\\npx.cmd');
  });
});

describe('UI_KIT_PACKAGES', () => {
  it('names both vendor packages', () => {
    expect(UI_KIT_PACKAGES.shadcn).toBe('shadcn@latest');
    expect(UI_KIT_PACKAGES.boardui).toBe('boardui@latest');
  });
});
