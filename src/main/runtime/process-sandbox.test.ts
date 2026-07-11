import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLinuxBubblewrapPlan,
  buildMacosSeatbeltPlan,
  buildScopedShellPlan,
  buildScopedExecPlan,
  createScopedSandboxHome,
} from './process-sandbox';

const tempDirs: string[] = [];

function makeDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(dir);
  return fs.realpathSync(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('process sandbox', () => {
  it('creates a private HOME and TMPDIR outside the checkout', () => {
    const root = makeDir('nexus-sandbox-root');

    const sandbox = createScopedSandboxHome({
      projectId: '11111111-1111-4111-8111-111111111111',
      checkoutId: 'checkout-a',
    });
    tempDirs.push(sandbox.dir);

    expect(sandbox.home).toBe(path.join(sandbox.dir, 'home'));
    expect(sandbox.tmp).toBe(path.join(sandbox.dir, 'tmp'));
    expect(fs.statSync(sandbox.home).mode & 0o077).toBe(0);
    expect(fs.statSync(sandbox.tmp).mode & 0o077).toBe(0);
    expect(sandbox.dir.startsWith(root)).toBe(false);
  });

  it('builds a fail-closed macOS Seatbelt plan', () => {
    const root = makeDir('nexus-sandbox-root');
    const runtime = makeDir('nexus-sandbox-runtime');

    const plan = buildMacosSeatbeltPlan({
      platform: 'darwin',
      executable: '/bin/sh',
      args: ['-c', 'pwd'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: runtime,
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
    }, '/usr/bin/sandbox-exec');

    expect(plan.file).toBe('/usr/bin/sandbox-exec');
    expect(plan.args.at(-3)).toBe('/bin/sh');
    expect(plan.args.at(-2)).toBe('-c');
    expect(plan.args.at(-1)).toBe('pwd');
    expect(plan.env.HOME).toBe(path.join(runtime, 'home'));
    expect(plan.env.TMPDIR).toBe(path.join(runtime, 'tmp'));

    const profile = plan.args[1];
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(JSON.stringify(root));
    expect(profile).toContain(JSON.stringify(runtime));
    expect(profile).not.toContain(JSON.stringify(os.homedir()) + ')');
  });

  it('fails closed on platforms without a confinement provider', () => {
    const root = makeDir('nexus-sandbox-root');
    const runtime = makeDir('nexus-sandbox-runtime');

    expect(() =>
      buildScopedShellPlan({
        platform: 'win32',
        command: 'dir',
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: '' },
      }),
    ).toThrow(/sandbox provider is unavailable/i);
  });

  it('builds a Linux Bubblewrap plan that masks user data (shared net for CI hosts)', () => {
    const root = makeDir('nexus-linux-root');
    const runtime = makeDir('nexus-linux-runtime');

    const plan = buildLinuxBubblewrapPlan({
      platform: 'linux',
      executable: '/usr/bin/node',
      args: ['--version'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: runtime,
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
    }, '/usr/bin/bwrap');

    expect(plan.file).toBe('/usr/bin/bwrap');
    expect(plan.args).toEqual(expect.arrayContaining([
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--share-net',
      '--ro-bind', '/', '/',
      '--tmpfs', '/home',
      '--tmpfs', '/tmp',
      '--bind', root, root,
      '--bind', runtime, runtime,
      '--chdir', root,
    ]));
    expect(plan.args.slice(-2)).toEqual(['/usr/bin/node', '--version']);
    expect(plan.env.HOME).toBe(path.join(runtime, 'home'));
    expect(plan.env.TMPDIR).toBe(path.join(runtime, 'tmp'));
  });

  it.runIf(process.platform === 'darwin')(
    'allows runtime metadata traversal to the checkout without exposing sibling contents',
    () => {
      const root = makeDir('nexus-sandbox-root');
      const runtime = makeDir('nexus-sandbox-runtime');
      const executable = fs.realpathSync(process.execPath);
      const plan = buildScopedExecPlan({
        platform: 'darwin',
        executable,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });

      const result = spawnSync(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(root);
    },
  );
});
