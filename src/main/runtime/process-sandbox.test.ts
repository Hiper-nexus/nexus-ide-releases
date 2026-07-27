import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLinuxBubblewrapPlan,
  buildMacosSeatbeltPlan,
  buildWindowsOciPlan,
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

function makeDirUnder(root: string, label: string): string {
  const dir = fs.mkdtempSync(path.join(root, `${label}-`));
  tempDirs.push(dir);
  return dir;
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

  it.runIf(process.platform !== 'win32')(
    'keeps default HOME and temp confined when the runtime uses a symlink alias',
    () => {
      const root = makeDir('nexus-sandbox-alias-root');
      const runtime = makeDir('nexus-sandbox-alias-runtime');
      const aliasParent = makeDir('nexus-sandbox-alias-parent');
      const runtimeAlias = path.join(aliasParent, 'runtime');
      fs.symlinkSync(runtime, runtimeAlias, 'dir');

      const plan = buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', 'true'],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtimeAlias,
        env: { PATH: '/usr/bin:/bin' },
      }, '/usr/bin/sandbox-exec');

      expect(plan.env.HOME).toBe(path.join(runtime, 'home'));
      expect(plan.env.TMPDIR).toBe(path.join(runtime, 'tmp'));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a private HOME symlink that resolves outside the runtime',
    () => {
      const root = makeDir('nexus-sandbox-home-root');
      const runtime = makeDir('nexus-sandbox-home-runtime');
      const outside = makeDir('nexus-sandbox-home-outside');
      fs.symlinkSync(outside, path.join(runtime, 'home'), 'dir');

      expect(() =>
        buildMacosSeatbeltPlan({
          platform: 'darwin',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          cwd: root,
          rootRealPath: root,
          sandboxDir: runtime,
          env: { PATH: '/usr/bin:/bin' },
        }, '/usr/bin/sandbox-exec'),
      ).toThrow(/resolves outside its runtime directory/i);
      expect(fs.existsSync(path.join(runtime, 'tmp'))).toBe(false);
    },
  );

  it('places specific Codex control denies after writable-root grants', () => {
    const root = makeDir('nexus-sandbox-root-controls');
    const runtime = makeDir('nexus-sandbox-runtime-controls');
    const provider = makeDir('nexus-sandbox-provider-state');
    const auth = path.join(provider, 'auth.json');
    fs.writeFileSync(auth, '{}');
    const privateHome = path.join(runtime, 'shell-home');
    const privateTmp = path.join(runtime, 'shell-tmp');
    const protectedAgents = path.join(root, '.agents');
    const protectedCodex = path.join(root, '.codex');

    const plan = buildMacosSeatbeltPlan({
      platform: 'darwin',
      executable: '/bin/sh',
      args: ['-c', 'true'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: runtime,
      privateHome,
      privateTmp,
      env: { PATH: '/usr/bin:/bin' },
      sandboxProfile: 'workspace-net',
      extraReadPaths: [auth],
      extraWritePaths: [auth],
      protectedWritePaths: [protectedAgents, protectedCodex],
    }, '/usr/bin/sandbox-exec');

    expect(plan.env.HOME).toBe(privateHome);
    expect(plan.env.TMPDIR).toBe(privateTmp);
    const profile = plan.args[1];
    const workspaceGrant =
      `(allow file-write* (subpath ${JSON.stringify(root)})`;
    const controlDeny =
      `(deny file-write* (literal ${JSON.stringify(protectedAgents)})`;
    expect(profile).toContain(workspaceGrant);
    expect(profile).toContain(controlDeny);
    expect(profile.indexOf(controlDeny)).toBeGreaterThan(
      profile.indexOf(workspaceGrant),
    );
    expect(profile).toContain(`(literal ${JSON.stringify(auth)})`);
  });

  it('allows network under workspace-net / yolo Seatbelt profiles', () => {
    const root = makeDir('nexus-sandbox-root-net');
    const runtime = makeDir('nexus-sandbox-runtime-net');

    const plan = buildMacosSeatbeltPlan({
      platform: 'darwin',
      executable: '/bin/sh',
      args: ['-c', 'true'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: runtime,
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
      sandboxProfile: 'workspace-net',
    }, '/usr/bin/sandbox-exec');

    expect(plan.args[1]).toContain('(allow network*)');
    expect(plan.args[1]).not.toContain('(deny network*)');
    // Still path-confined
    expect(plan.args[1]).toContain('(deny file-write*)');
  });

  it('rejects a broad network profile mixed with process-scoped authority', () => {
    const root = makeDir('nexus-sandbox-root-net-conflict');
    const runtime = makeDir('nexus-sandbox-runtime-net-conflict');

    expect(() =>
      buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', 'true'],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: '/usr/bin:/bin' },
        sandboxProfile: 'workspace-net',
        networkAllowedProcessPaths: ['/bin/sh'],
      }, '/usr/bin/sandbox-exec'),
    ).toThrow(/cannot be combined with broad network access/i);
  });

  it.runIf(process.platform === 'darwin')(
    'allows only the pinned provider process onto the network',
    async () => {
      const root = makeDir('nexus-codex-provider-net-root');
      const runtime = makeDir('nexus-codex-provider-net-runtime');
      const curl = fs.realpathSync('/usr/bin/curl');
      const unrelatedProcess = fs.realpathSync('/usr/bin/false');
      const server = createServer((_request, response) => response.end('ok'));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('network probe did not receive a TCP port');
      }
      const run = (
        plan: ReturnType<typeof buildMacosSeatbeltPlan>,
      ): Promise<{ code: number | null; stdout: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(plan.file, plan.args, {
            cwd: plan.cwd,
            env: plan.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stdout }));
        });
      const input = {
        platform: 'darwin' as const,
        executable: curl,
        args: [
          '--fail',
          '--silent',
          '--max-time',
          '2',
          `http://127.0.0.1:${address.port}/`,
        ],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: '/usr/bin:/bin' },
        sandboxProfile: 'workspace-only' as const,
      };

      try {
        const allowedPlan = buildMacosSeatbeltPlan({
          ...input,
          networkAllowedProcessPaths: [curl],
        }, '/usr/bin/sandbox-exec');
        expect(allowedPlan.args[1]).toContain('(deny network*)');
        expect(allowedPlan.args[1]).toContain(
          `(with-filter (process-path ${JSON.stringify(curl)})`,
        );
        await expect(run(allowedPlan)).resolves.toEqual({
          code: 0,
          stdout: 'ok',
        });

        const deniedPlan = buildMacosSeatbeltPlan({
          ...input,
          networkAllowedProcessPaths: [unrelatedProcess],
        }, '/usr/bin/sandbox-exec');
        const denied = await run(deniedPlan);
        expect(denied.code).not.toBe(0);
        expect(denied.stdout).toBe('');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

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

  it('fails closed when a non-macOS provider cannot enforce absent control-root denies', () => {
    const root = makeDir('nexus-linux-controlled-root');
    const runtime = makeDir('nexus-linux-controlled-runtime');
    expect(() =>
      buildLinuxBubblewrapPlan({
        platform: 'linux',
        executable: '/usr/bin/node',
        args: ['--version'],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: '/usr/bin:/bin' },
        protectedWritePaths: [path.join(root, '.agents')],
      }, '/usr/bin/bwrap'),
    ).toThrow(/supplemental process sandbox roots are unavailable on linux/i);
  });

  it('makes validation checkout read-only while preserving writable private runtime', () => {
    const root = makeDir('nexus-readonly-root');
    const runtime = makeDir('nexus-readonly-runtime');
    const plan = buildLinuxBubblewrapPlan({
      platform: 'linux', executable: '/usr/bin/node', args: ['--version'], cwd: root,
      rootRealPath: root, sandboxDir: runtime, env: { PATH: '/usr/bin:/bin' },
      readOnlyRoot: true,
    }, '/usr/bin/bwrap');

    const rootIndex = plan.args.findIndex((value, index) => value === root && plan.args[index + 1] === root);
    expect(plan.args[rootIndex - 1]).toBe('--ro-bind');
    const runtimeIndex = plan.args.findIndex((value, index) => value === runtime && plan.args[index + 1] === runtime);
    expect(plan.args[runtimeIndex - 1]).toBe('--bind');
  });

  it('builds a digest-pinned, networkless Windows OCI sandbox plan', () => {
    const root = makeDir('nexus-windows-root');
    const runtime = makeDir('nexus-windows-runtime');
    const image = `registry.example/nexus-sensors@sha256:${'a'.repeat(64)}`;
    const plan = buildWindowsOciPlan({
      platform: 'win32',
      executable: path.join(root, 'node.exe'),
      args: ['--version'],
      cwd: root,
      rootRealPath: root,
      sandboxDir: runtime,
      env: { PATH: root },
      readOnlyRoot: true,
    }, path.join(root, 'docker.exe'), image);

    expect(plan.args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', image, 'node', '--version',
    ]));
    expect(plan.args).toContain(`type=bind,src=${root},dst=/workspace,readonly`);
    expect(() => buildWindowsOciPlan({
      platform: 'win32', executable: path.join(root, 'node.exe'), args: [], cwd: root,
      rootRealPath: root, sandboxDir: runtime, env: { PATH: root },
    }, path.join(root, 'docker.exe'), 'registry.example/nexus-sensors:latest')).toThrow(/pinned/);
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

  it.runIf(process.platform === 'darwin')(
    'physically denies writes through every system temp alias outside the mission scope',
    () => {
      const root = makeDir('nexus-codex-temp-scope');
      const runtime = makeDir('nexus-codex-temp-runtime');
      const aliases = [
        '/tmp',
        '/private/tmp',
        '/var/tmp',
        '/private/var/tmp',
      ] as const;
      const escapeDirs = aliases.map((alias, index) =>
        makeDirUnder(alias, `nexus-codex-temp-escape-${index}`),
      );
      const command = escapeDirs
        .map(
          (_dir, index) =>
            `printf escaped > "$ESCAPE_${index}/marker"; ` +
            `echo escape_${index}=$?`,
        )
        .join('\n');
      const plan = buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', command],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: Object.fromEntries([
          ['PATH', '/usr/bin:/bin'],
          ...escapeDirs.map(
            (dir, index) => [`ESCAPE_${index}`, dir] as const,
          ),
        ]),
        sandboxProfile: 'workspace-net',
      }, '/usr/bin/sandbox-exec');

      const result = spawnSync(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      for (const [index, dir] of escapeDirs.entries()) {
        expect(result.stdout).toContain(`escape_${index}=1`);
        expect(fs.existsSync(path.join(dir, 'marker'))).toBe(false);
      }
    },
  );

  it.runIf(process.platform === 'darwin')(
    'keeps a workspace under /private/tmp physically read-only',
    () => {
      const root = makeDirUnder(
        '/private/tmp',
        'nexus-codex-readonly-workspace',
      );
      const runtime = makeDir('nexus-codex-readonly-runtime');
      const agents = path.join(root, '.agents');
      const codex = path.join(root, '.codex');
      fs.mkdirSync(agents);
      fs.mkdirSync(codex);
      fs.writeFileSync(path.join(root, 'input.txt'), 'readable\n');
      const command = [
        '/bin/cat "$ROOT/input.txt"',
        'echo read=$?',
        'printf changed > "$ROOT/output.txt"',
        'echo ordinary_write=$?',
        'printf changed > "$ROOT/.agents/SKILL.md"',
        'echo agents_write=$?',
        'printf changed > "$ROOT/.codex/config.toml"',
        'echo codex_write=$?',
      ].join('\n');
      const plan = buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', command],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        readOnlyRoot: true,
        env: { PATH: '/usr/bin:/bin', ROOT: root },
        sandboxProfile: 'workspace-net',
        protectedWritePaths: [agents, codex],
      }, '/usr/bin/sandbox-exec');

      const result = spawnSync(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('readable');
      expect(result.stdout).toContain('read=0');
      expect(result.stdout).toContain('ordinary_write=1');
      expect(result.stdout).toContain('agents_write=1');
      expect(result.stdout).toContain('codex_write=1');
      expect(fs.existsSync(path.join(root, 'output.txt'))).toBe(false);
      expect(fs.existsSync(path.join(agents, 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(codex, 'config.toml'))).toBe(false);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'allows ordinary work under /private/tmp but protects .agents and .codex',
    () => {
      const root = makeDirUnder(
        '/private/tmp',
        'nexus-codex-writable-workspace',
      );
      const runtime = makeDir('nexus-codex-writable-runtime');
      const agents = path.join(root, '.agents');
      const codex = path.join(root, '.codex');
      fs.mkdirSync(agents);
      fs.mkdirSync(codex);
      const command = [
        'printf changed > "$ROOT/output.txt"',
        'echo ordinary_write=$?',
        'printf changed > "$ROOT/.agents/SKILL.md"',
        'echo agents_write=$?',
        'printf changed > "$ROOT/.codex/config.toml"',
        'echo codex_write=$?',
      ].join('\n');
      const plan = buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', command],
        cwd: root,
        rootRealPath: root,
        sandboxDir: runtime,
        env: { PATH: '/usr/bin:/bin', ROOT: root },
        sandboxProfile: 'workspace-net',
        protectedWritePaths: [agents, codex],
      }, '/usr/bin/sandbox-exec');

      const result = spawnSync(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ordinary_write=0');
      expect(result.stdout).toContain('agents_write=1');
      expect(result.stdout).toContain('codex_write=1');
      expect(fs.readFileSync(path.join(root, 'output.txt'), 'utf8')).toBe(
        'changed',
      );
      expect(fs.existsSync(path.join(agents, 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(codex, 'config.toml'))).toBe(false);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'physically denies post-scan skill creation while mirrored skills remain readable',
    () => {
      const root = makeDir('nexus-codex-outer-root');
      const runtime = makeDir('nexus-codex-outer-runtime');
      const cwd = path.join(root, 'packages', 'app');
      const physicalSkills = path.join(root, 'physical-skill-root');
      const mirroredSkill = path.join(
        runtime,
        'skills',
        'allowed',
        'SKILL.md',
      );
      const mirroredScript = path.join(
        runtime,
        'skills',
        'allowed',
        'scripts',
        'proof.sh',
      );
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(physicalSkills);
      fs.mkdirSync(path.dirname(mirroredSkill), { recursive: true });
      fs.writeFileSync(mirroredSkill, '# allowed-skill\n');
      fs.mkdirSync(path.dirname(mirroredScript), { recursive: true });
      fs.writeFileSync(
        mirroredScript,
        '#!/bin/sh\necho allowed-skill-script\n',
        { mode: 0o700 },
      );
      fs.symlinkSync(physicalSkills, path.join(root, '.agents'), 'dir');

      const command = [
        'set +e',
        '/bin/mkdir -p "$ROOT/packages/app/.agents/skills/new"',
        'echo absent_agents=$?',
        '/bin/mkdir -p "$ROOT/packages/app/.codex/skills/new"',
        'echo absent_codex=$?',
        'echo injected > "$ROOT/physical-skill-root/SKILL.md"',
        'echo physical_write=$?',
        '/bin/rm "$ROOT/.agents"',
        'echo unlink_control=$?',
        '/bin/mkdir "$ROOT/candidate-control"',
        '/bin/mv "$ROOT/candidate-control" "$ROOT/.codex"',
        'echo rename_control=$?',
        '/bin/ln -s "$ROOT/physical-skill-root" "$ROOT/packages/app/.agents"',
        'echo symlink_control=$?',
        '/bin/mkdir -p "$ROOT/safe"',
        'echo ok > "$ROOT/safe/output.txt"',
        'echo ordinary_write=$?',
        '/bin/cat "$MIRRORED_SKILL"',
        'echo mirrored_read=$?',
        '"$MIRRORED_SCRIPT"',
        'echo mirrored_exec=$?',
        'echo mutate >> "$MIRRORED_SKILL"',
        'echo mirrored_write=$?',
        '/bin/mkdir "$RUNTIME/candidate-skill"',
        '/bin/mv "$RUNTIME/candidate-skill" "$RUNTIME/skills/new-skill"',
        'echo mirrored_rename=$?',
      ].join('\n');
      const plan = buildMacosSeatbeltPlan({
        platform: 'darwin',
        executable: '/bin/sh',
        args: ['-c', command],
        cwd,
        rootRealPath: root,
        sandboxDir: runtime,
        privateHome: path.join(runtime, 'shell-home'),
        privateTmp: path.join(runtime, 'shell-tmp'),
        env: {
          PATH: '/usr/bin:/bin',
          ROOT: root,
          RUNTIME: runtime,
          MIRRORED_SKILL: mirroredSkill,
          MIRRORED_SCRIPT: mirroredScript,
        },
        sandboxProfile: 'workspace-net',
        protectedWritePaths: [
          path.join(root, '.agents'),
          path.join(root, '.codex'),
          path.join(cwd, '.agents'),
          path.join(cwd, '.codex'),
          physicalSkills,
          path.join(runtime, 'skills'),
          path.join(runtime, 'shell-home', '.agents'),
          path.join(runtime, 'shell-home', '.codex'),
        ],
      }, '/usr/bin/sandbox-exec');

      const result = spawnSync(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('absent_agents=1');
      expect(result.stdout).toContain('absent_codex=1');
      expect(result.stdout).toContain('physical_write=1');
      expect(result.stdout).toContain('unlink_control=1');
      expect(result.stdout).toContain('rename_control=1');
      expect(result.stdout).toContain('symlink_control=1');
      expect(result.stdout).toContain('ordinary_write=0');
      expect(result.stdout).toContain('# allowed-skill');
      expect(result.stdout).toContain('mirrored_read=0');
      expect(result.stdout).toContain('allowed-skill-script');
      expect(result.stdout).toContain('mirrored_exec=0');
      expect(result.stdout).toContain('mirrored_write=1');
      expect(result.stdout).toContain('mirrored_rename=1');
      expect(
        fs.existsSync(path.join(cwd, '.agents', 'skills', 'new')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(cwd, '.codex', 'skills', 'new')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(physicalSkills, 'SKILL.md')),
      ).toBe(false);
      expect(fs.lstatSync(path.join(root, '.agents')).isSymbolicLink()).toBe(
        true,
      );
      expect(fs.readFileSync(mirroredSkill, 'utf8')).toBe('# allowed-skill\n');
      expect(fs.existsSync(path.join(runtime, 'skills', 'new-skill'))).toBe(
        false,
      );
      expect(fs.readFileSync(path.join(root, 'safe', 'output.txt'), 'utf8')).toBe(
        'ok\n',
      );
    },
  );
});
