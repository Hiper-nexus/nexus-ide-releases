import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeLocalGitConfig,
  assertSafeLocalGitConfigAsync,
  AsyncProcessGitRunner,
  isExecutableGitConfigEntry,
  ProcessGitRunner,
  type GitRunner,
} from './git-command';

function runnerWith(stdout: string): GitRunner {
  return {
    run: vi.fn(() => ({ status: stdout.trim() ? 0 : 1, stdout, stderr: '' })),
  } as unknown as GitRunner;
}

describe('isExecutableGitConfigEntry', () => {
  it('treats the built-in fsmonitor daemon as non-executable', () => {
    // Field trap (28/07): `core.fsmonitor=true` selects Git's own daemon and
    // spawns nothing, but the key-only check refused the repository and
    // blocked every worker in it over a pure performance setting.
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'true')).toBe(false);
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'false')).toBe(false);
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'TRUE')).toBe(false);
  });

  it('still refuses an fsmonitor that names a command', () => {
    expect(isExecutableGitConfigEntry('core.fsmonitor', '.git/hooks/fsm')).toBe(
      true,
    );
    expect(isExecutableGitConfigEntry('core.fsmonitor', '/usr/bin/evil')).toBe(
      true,
    );
  });

  it('refuses config that always carries a command', () => {
    expect(isExecutableGitConfigEntry('core.hookspath', '.githooks')).toBe(true);
    expect(isExecutableGitConfigEntry('core.sshcommand', 'ssh -i k')).toBe(true);
    expect(isExecutableGitConfigEntry('filter.lfs.clean', 'git-lfs clean')).toBe(
      true,
    );
    expect(isExecutableGitConfigEntry('diff.x.textconv', 'cat')).toBe(true);
    expect(isExecutableGitConfigEntry('merge.x.driver', 'merge %A')).toBe(true);
    expect(isExecutableGitConfigEntry('credential.helper', 'store')).toBe(true);
  });

  it('distinguishes the submodule update forms', () => {
    // Only `!command` executes; the named strategies do not.
    expect(isExecutableGitConfigEntry('submodule.a.update', 'checkout')).toBe(
      false,
    );
    expect(isExecutableGitConfigEntry('submodule.a.update', 'rebase')).toBe(
      false,
    );
    expect(isExecutableGitConfigEntry('submodule.a.update', '!evil.sh')).toBe(
      true,
    );
  });

  it('treats an empty value as disabled', () => {
    expect(isExecutableGitConfigEntry('core.hookspath', '')).toBe(false);
    expect(isExecutableGitConfigEntry('credential.helper', '   ')).toBe(false);
  });
});

describe('assertSafeLocalGitConfig', () => {
  it('accepts a repository whose only match is the built-in fsmonitor', () => {
    expect(() =>
      assertSafeLocalGitConfig(runnerWith('core.fsmonitor true\n'), '/repo'),
    ).not.toThrow();
  });

  it('refuses and names the offending keys', () => {
    expect(() =>
      assertSafeLocalGitConfig(
        runnerWith('core.fsmonitor true\ncore.hookspath .githooks\n'),
        '/repo',
      ),
    ).toThrow(/core\.hookspath/);
    // The safe entry must not be reported as an offender.
    expect(() =>
      assertSafeLocalGitConfig(
        runnerWith('core.fsmonitor true\ncore.hookspath .githooks\n'),
        '/repo',
      ),
    ).toThrow(/^(?!.*core\.fsmonitor).*core\.hookspath/s);
  });

  it('accepts a repository with no matching config at all', () => {
    expect(() =>
      assertSafeLocalGitConfig(runnerWith(''), '/repo'),
    ).not.toThrow();
  });

  it('supports asynchronous main-process inspection with the same policy', async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: 'core.fsmonitor true\ncore.hookspath .githooks\n',
      stderr: '',
    }));

    await expect(
      assertSafeLocalGitConfigAsync({ run }, '/repo'),
    ).rejects.toThrow(/core\.hookspath/);
  });
});

describe('ProcessGitRunner global/system config (F-580)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honours the user global git config (credential helpers, user.name/email)', () => {
    // Antes do F-580 o runner impunha GIT_CONFIG_NOSYSTEM=1 e
    // GIT_CONFIG_GLOBAL=/dev/null: todo helper de credencial (gh
    // git-credential, osxkeychain, GCM) e o user.name/email sumiam, e qualquer
    // push/pull HTTPS morria com "could not read Username".
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-home-'));
    try {
      fs.writeFileSync(
        path.join(home, '.gitconfig'),
        '[user]\n\temail = runner@example.test\n',
      );
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));

      const result = new ProcessGitRunner().run(process.cwd(), [
        'config',
        '--global',
        '--get',
        'user.email',
      ]);

      expect(result.stdout.trim()).toBe('runner@example.test');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AsyncProcessGitRunner', () => {
  it('runs Git without occupying the caller event-loop turn', async () => {
    const pending = new AsyncProcessGitRunner().run(process.cwd(), [
      'rev-parse',
      '--is-inside-work-tree',
    ]);

    await expect(
      new Promise<string>((resolve) => setImmediate(() => resolve('free'))),
    ).resolves.toBe('free');
    await expect(pending).resolves.toMatchObject({
      status: 0,
      stdout: expect.stringMatching(/true/i),
    });
  });
});
