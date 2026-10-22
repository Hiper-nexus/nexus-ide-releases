import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPathStaysInProject,
  claimUiKitProjectWrite,
  assertSafeEnvName,
  isAlreadyGoneKillError,
  UI_KIT_DEFAULT_NPM_REGISTRY,
  assertSafeUiKitArgs,
  assertSafeUiKitCwd,
  buildUiKitChildEnv,
  resolveNpxCommand,
  resolveUiKitNpxLaunch,
  runUiKitCli,
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
  it('switches the vendors analytics off, and nothing can switch it back on', () => {
    const env = buildUiKitChildEnv(
      { DO_NOT_TRACK: '0', BOARDUI_TELEMETRY_DISABLED: '0' },
      {},
    );

    expect(env.DO_NOT_TRACK).toBe('1');
    expect(env.BOARDUI_TELEMETRY_DISABLED).toBe('1');
  });

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

  it('forwards XDG_CONFIG_HOME so the licence file lands where the child reads it', () => {
    // BoardUI resolves its config root from this variable on Linux — and on any
    // session that exports it: the Main writes `license.json` through the SAME
    // child env, so dropping it here would split the two sides apart.
    const env = buildUiKitChildEnv({ PATH: '/usr/bin', XDG_CONFIG_HOME: '/xdg-root' });

    expect(env.XDG_CONFIG_HOME).toBe('/xdg-root');
  });

  it('pins the npm registry so a project .npmrc cannot choose the package', () => {
    // npm reads a .npmrc from its cwd, and a writing run uses the project as
    // cwd: without this the repository decides which `shadcn` we execute.
    expect(buildUiKitChildEnv({ PATH: '/usr/bin' }).npm_config_registry).toBe(
      UI_KIT_DEFAULT_NPM_REGISTRY,
    );
  });

  it("keeps the operator's own mirror when they configured one", () => {
    expect(
      buildUiKitChildEnv({ npm_config_registry: 'https://mirror.corp.test/' })
        .npm_config_registry,
    ).toBe('https://mirror.corp.test/');
  });

  it('pins the keys a project .npmrc could redirect resolution with', () => {
    const env = buildUiKitChildEnv({ PATH: '/usr/bin' });

    // Empty is how npm is told "no proxy"; an env value beats the project's.
    expect(env.npm_config_proxy).toBe('');
    expect(env.npm_config_https_proxy).toBe('');
    expect(env.npm_config_ca).toBe('');
    expect(env.npm_config_cafile).toBe('');
    // And a project cannot turn certificate checking off for our download.
    expect(env.npm_config_strict_ssl).toBe('true');
  });

  it('adds a validated registry token', () => {
    const env = buildUiKitChildEnv({ PATH: '/usr/bin' }, { REGISTRY_TOKEN: 't0ken' });

    expect(env.REGISTRY_TOKEN).toBe('t0ken');
  });

  it('refuses a lowercase or malformed registry env name', () => {
    expect(() => buildUiKitChildEnv({}, { registry_token: 'x' })).toThrow(UiKitCliError);
    expect(() => buildUiKitChildEnv({}, { 'A-B': 'x' })).toThrow(UiKitCliError);
  });

  it('refuses to let a caller override PATH or an npm config knob', () => {
    expect(() => assertSafeEnvName('PATH')).toThrow(/cannot be overridden/);
    expect(() => assertSafeEnvName('NPM_CONFIG_REGISTRY')).toThrow(/NPM_CONFIG\* family/);
  });

  it.each([
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NPM_CONFIG_SCRIPT_SHELL',
    'GIT_SSH_COMMAND',
    'BASH_ENV',
    'ELECTRON_RUN_AS_NODE',
  ])('refuses %s, which could inject code or repoint the install', (name) => {
    expect(() => assertSafeEnvName(name)).toThrow(UiKitCliError);
  });

  it('refuses a name that does not look like a credential at all', () => {
    // The channel exists for registry auth; anything else has no business
    // reaching the child's environment.
    expect(() => assertSafeEnvName('HTTP_PROXY')).toThrow(/does not look like a registry credential/);
    expect(() => assertSafeEnvName('FOO')).toThrow(/does not look like a registry credential/);
  });

  it.each([
    'REGISTRY_TOKEN',
    'ACME_API_KEY',
    'INTERNAL_REGISTRY_SECRET',
    'REGISTRY_AUTH',
    'BOARDUI_LICENSE',
    'VENDOR_CREDENTIAL',
  ])('accepts the real credential name %s', (name) => {
    expect(assertSafeEnvName(name)).toBe(name);
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

describe('resolveUiKitNpxLaunch', () => {
  it('uses a real Node with the npm entrypoint when the npm prefix is separate', () => {
    const files = new Set([
      'C:\\npm prefix\\npx.cmd',
      'C:\\npm prefix\\node_modules\\npm\\bin\\npx-cli.js',
      'C:\\Node runtime\\node.exe',
    ]);
    expect(resolveUiKitNpxLaunch({ platform: 'win32',
      pathString: 'C:\\npm prefix;C:\\Node runtime', exists: file => files.has(file) }))
      .toEqual({ command: 'C:\\Node runtime\\node.exe',
        argsPrefix: ['C:\\npm prefix\\node_modules\\npm\\bin\\npx-cli.js'] });
  });

  it('supports npm installed in a local node_modules/.bin', () => {
    const files = new Set(['C:\\tools\\node_modules\\.bin\\npx.cmd',
      'C:\\tools\\node_modules\\npm\\bin\\npx-cli.js', 'C:\\node\\node.exe']);
    expect(resolveUiKitNpxLaunch({ platform: 'win32',
      pathString: 'C:\\tools\\node_modules\\.bin;C:\\node', exists: file => files.has(file) }))
      .toEqual({ command: 'C:\\node\\node.exe',
        argsPrefix: ['C:\\tools\\node_modules\\npm\\bin\\npx-cli.js'] });
  });

  it('refuses an unresolved batch launcher rather than enabling a shell', () => {
    expect(() => resolveUiKitNpxLaunch({ platform: 'win32',
      pathString: 'C:\\missing', exists: () => false })).toThrow(UiKitCliError);
  });

  it('keeps native launchers and POSIX npx directly executable', () => {
    expect(resolveUiKitNpxLaunch({ platform: 'linux' }))
      .toEqual({ command: 'npx', argsPrefix: [] });
    expect(resolveUiKitNpxLaunch({ platform: 'win32', pathString: 'C:\\node',
      exists: file => file === 'C:\\node\\npx.exe' }))
      .toEqual({ command: 'C:\\node\\npx.exe', argsPrefix: [] });
  });
});

describe('UI_KIT_PACKAGES', () => {
  it('names both vendor packages', () => {
    expect(UI_KIT_PACKAGES.shadcn).toBe('shadcn@latest');
    expect(UI_KIT_PACKAGES.boardui).toBe('boardui@latest');
  });
});

describe('isAlreadyGoneKillError', () => {
  it('treats ESRCH as the outcome teardown wanted', () => {
    expect(isAlreadyGoneKillError(Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }))).toBe(true);
  });

  it('still reports a real failure like EPERM', () => {
    expect(isAlreadyGoneKillError(Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))).toBe(false);
    expect(isAlreadyGoneKillError(new Error('plain'))).toBe(false);
    expect(isAlreadyGoneKillError(null)).toBe(false);
  });
});

describe('assertPathStaysInProject', () => {
  /** `links` are symlinks: name -> raw link text. `real` are plain entries. */
  function stub(links: Record<string, string>, real: readonly string[]) {
    // Production walks native absolute paths; the fixture must use those too
    // or its POSIX-only keys silently hide every link on Windows.
    const nativeLinks = new Map(Object.entries(links).map(([name, value]) => [path.resolve(name), value]));
    const nativeReal = new Set(real.map(name => path.resolve(name)));
    return {
      realpathSync: (target: string) => path.resolve(target),
      lstatSync: (target: string) => {
        if (nativeLinks.has(target)) return { isSymbolicLink: () => true };
        if (nativeReal.has(target)) return { isSymbolicLink: () => false };
        throw new Error('ENOENT');
      },
      readlinkSync: (target: string) => {
        const value = nativeLinks.get(target);
        if (value === undefined) throw new Error('EINVAL');
        return value;
      },
    };
  }

  it('accepts a destination that does not exist yet', () => {
    expect(
      assertPathStaysInProject('/projects/app', 'src/components/ui', stub({}, ['/projects/app'])),
    ).toBe('src/components/ui');
  });

  it('accepts a real directory inside the project', () => {
    expect(
      assertPathStaysInProject('/projects/app', 'src/ui', stub({}, ['/projects/app/src'])),
    ).toBe('src/ui');
  });

  it('refuses a path that resolves out of the project', () => {
    expect(() =>
      assertPathStaysInProject('/projects/app', '../../etc', stub({}, [])),
    ).toThrow(/resolves outside the project/);
  });

  it('refuses the project root itself as a destination', () => {
    expect(() => assertPathStaysInProject('/projects/app', '.', stub({}, []))).toThrow(
      /resolves outside the project/,
    );
  });

  it('refuses a destination behind a symlinked ancestor', () => {
    expect(() =>
      assertPathStaysInProject(
        '/projects/app',
        'components/ui',
        stub({ '/projects/app/components': '/etc' }, []),
      ),
    ).toThrow(/leaves the project through a link/);
  });

  it('refuses a DANGLING link that points outside', () => {
    // The one `existsSync` missed: it follows links, so a link to a missing
    // target read as "nothing here" and the walk went past it — and then a
    // `mkdir -p` through that link CREATES the target outside.
    expect(() =>
      assertPathStaysInProject(
        '/projects/app',
        'components/ui',
        stub({ '/projects/app/components': '/tmp/evil-does-not-exist' }, []),
      ),
    ).toThrow(/leaves the project through a link/);
  });

  it('accepts a dangling link that stays inside', () => {
    // A write would create the target in there, which is contained.
    expect(
      assertPathStaysInProject(
        '/projects/app',
        'components/ui',
        stub({ '/projects/app/components': '/projects/app/generated' }, []),
      ),
    ).toBe('components/ui');
  });

  it('follows a chain of inside links and stops at a hop limit', () => {
    expect(
      assertPathStaysInProject(
        '/projects/app',
        'a/ui',
        stub(
          { '/projects/app/a': '/projects/app/b', '/projects/app/b': '/projects/app/c' },
          ['/projects/app/c'],
        ),
      ),
    ).toBe('a/ui');

    const loop = stub(
      { '/projects/app/a': '/projects/app/b', '/projects/app/b': '/projects/app/a' },
      [],
    );
    expect(() => assertPathStaysInProject('/projects/app', 'a/ui', loop)).toThrow(
      /too many links/,
    );
  });

  it('refuses a link whose TARGET PATH crosses another link out of the project', () => {
    // The bypass the previous walk had: `a -> b/c` string-checks clean
    // (relative is `b/c`), and jumping straight to it never examines `b`,
    // which is the link that leaves. Only re-walking the target finds it.
    expect(() =>
      assertPathStaysInProject(
        '/projects/app',
        'a/x',
        stub(
          { '/projects/app/a': '/projects/app/b/c', '/projects/app/b': '/etc' },
          [],
        ),
      ),
    ).toThrow(/leaves the project through a link/);
  });

  it('accepts the same shape when every hop stays inside', () => {
    expect(
      assertPathStaysInProject(
        '/projects/app',
        'a/x',
        stub(
          { '/projects/app/a': '/projects/app/b/c', '/projects/app/b': '/projects/app/real' },
          ['/projects/app/real'],
        ),
      ),
    ).toBe('a/x');
  });

  it('refuses a link target that climbs out with ..', () => {
    expect(() =>
      assertPathStaysInProject(
        '/projects/app',
        'a/x',
        stub({ '/projects/app/a': '../../etc' }, []),
      ),
    ).toThrow(/leaves the project through a link/);
  });

  it('refuses a value the builder would normalise differently', () => {
    // The parser differential: checking " components" and running
    // "components" validates a path that is not the one used.
    expect(() =>
      assertPathStaysInProject('/projects/app', ' components', stub({}, [])),
    ).toThrow(/leading or trailing whitespace/);
  });

  it('fails when the project directory itself does not resolve', () => {
    expect(() =>
      assertPathStaysInProject('/gone', 'src', {
        realpathSync: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/does not resolve/);
  });
});

describe('claimUiKitProjectWrite', () => {
  it('holds one writer per project and names how long the first has run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-slot-'));
    try {
      const release = claimUiKitProjectWrite(dir, 1_000);
      expect(() => claimUiKitProjectWrite(dir, 31_000)).toThrow(/started 30 s ago/);
      try {
        claimUiKitProjectWrite(dir, 31_000);
      } catch (error) {
        expect((error as UiKitCliError).code).toBe('PROJECT_BUSY');
        expect((error as UiKitCliError).hint).toMatch(/retry only what is missing/);
      }
      release();
      release(); // idempotent
      const again = claimUiKitProjectWrite(dir, 40_000);
      again();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two projects independent', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-slot-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-slot-b-'));
    try {
      const releaseA = claimUiKitProjectWrite(a);
      const releaseB = claimUiKitProjectWrite(b);
      releaseA();
      releaseB();
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('runUiKitCli keeps output past 64 KiB', () => {
  // Both vendor CLIs console.log their JSON and then process.exit(). On a
  // pipe Node writes asynchronously and the exit drops what has not drained:
  // `view dashboard-01` (77 KB) and a 200-item search arrived cut at exactly
  // 65 536 bytes (measured 22/10/2026). The fake npx reproduces that exit.
  it('returns the whole JSON a child printed right before exiting', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-bigout-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-bigout-proj-'));
    const previousPath = process.env.PATH;
    try {
      const npx = path.join(fixture, 'npx');
      fs.writeFileSync(
        npx,
        '#!/usr/bin/env node\n' +
          "const items = Array.from({ length: 3000 }, (_, i) => ({ name: 'item-' + i, pad: 'x'.repeat(40) }));\n" +
          'console.log(JSON.stringify({ items }));\n' +
          'process.exit(0);\n',
        { mode: 0o755 },
      );
      process.env.PATH = `${fixture}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${previousPath ?? ''}`;

      const result = await runUiKitCli({ kit: 'shadcn', cwd: project, args: ['search', '@shadcn', '--json'] });

      expect(result.code).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(65_536);
      expect(JSON.parse(result.stdout).items).toHaveLength(3000);
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
