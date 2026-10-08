import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeRegressionCommand } from './native-regression-command';

const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-native-command-'))); roots.push(root);
  const cwd = path.join(root, 'project'), sandbox = path.join(root, 'sandbox'), sdk = path.join(root, 'sdk');
  await Promise.all([cwd, sandbox, path.join(sdk, 'bin'), path.join(sdk, 'lib', 'rustlib')].map(p => fs.mkdir(p, { recursive: true })));
  const bin = async (name: string, dir = path.join(sdk, 'bin')) => { await fs.mkdir(dir, { recursive: true }); const file = path.join(dir, name); await fs.writeFile(file, '', { mode: 0o755 }); return file; };
  return { root, cwd, sandbox, sdk, bin };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('native regression command environment', () => {
  it('resolves rustup proxies to installed tools and grants only their SDK, with private Cargo cache', async () => {
    const f = await fixture(); const rustup = await f.bin('rustup', path.join(f.root, 'shims'));
    const actual = { cargo: await f.bin('cargo'), rustc: await f.bin('rustc'), rustdoc: await f.bin('rustdoc') };
    const probe = vi.fn(async (_file: string, args: readonly string[]) => actual[args[1] as keyof typeof actual]);
    const result = await prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, { PATH: '/usr/bin', SECRET_TOKEN: 'must-not-copy' }, {
      rootRealPath: f.cwd, platform: 'darwin', ports: { resolve: () => rustup, home: () => path.join(f.root, 'native-home'), probe },
    });
    expect(result.file).toBe(actual.cargo);
    expect(result.env).toMatchObject({ RUSTC: actual.rustc, RUSTDOC: actual.rustdoc, CARGO_BUILD_JOBS: '1', RUSTUP_AUTO_INSTALL: '0' });
    expect(result.env.CARGO_HOME).toBe(path.join(f.sandbox, 'native', 'cargo'));
    expect(result.env.CARGO_TARGET_DIR).toBe(path.join(f.sandbox, 'native', 'target'));
    expect(result.env.SECRET_TOKEN).toBeUndefined(); expect(result.env.CARGO_NET_OFFLINE).toBeUndefined();
    expect(result.extraReadPaths).toEqual([path.join(f.sdk, 'bin'), path.join(f.sdk, 'lib')]);
    expect(probe).toHaveBeenCalledTimes(3);
    for (const call of probe.mock.calls) expect(call[0]).toBe(rustup);
  });

  it('uses a directly installed Rust SDK without invoking rustup', async () => {
    const f = await fixture(); const actual = { cargo: await f.bin('cargo'), rustc: await f.bin('rustc'), rustdoc: await f.bin('rustdoc') };
    const probe = vi.fn();
    const result = await prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, { PATH: '/usr/bin' }, {
      platform: 'linux', ports: { resolve: name => actual[name as keyof typeof actual] ?? null, probe },
    });
    expect(result.file).toBe(actual.cargo); expect(probe).not.toHaveBeenCalled();
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.join(f.sdk, 'bin'));
  });

  it('keeps Go caches writable and resolves GOROOT without executing project code or downloading a toolchain', async () => {
    const f = await fixture(); const go = await f.bin('go');
    await Promise.all([fs.mkdir(path.join(f.sdk, 'pkg', 'tool'), { recursive: true }), fs.mkdir(path.join(f.sdk, 'src', 'runtime'), { recursive: true })]);
    const probe = vi.fn();
    const result = await prepareNativeRegressionCommand('go', f.cwd, f.sandbox, { PATH: '/usr/bin', GOFLAGS: '-toolexec=untrusted' }, {
      platform: 'linux', ports: { resolve: () => go, probe },
    });
    expect(result.env).toMatchObject({ GOROOT: f.sdk, GOTOOLCHAIN: 'local', GOENV: 'off', GOMAXPROCS: '1' });
    expect(result.env.GOCACHE).toBe(path.join(f.sandbox, 'native', 'go-cache'));
    expect(result.env.GOPATH).toBe(path.join(f.sandbox, 'native', 'go'));
    expect(result.env.GOFLAGS).toBeUndefined(); expect(result.env.GOWORK).toBe('off'); expect(probe).not.toHaveBeenCalled();
  });

  it('preserves an in-scope Go workspace and refuses cross-project local modules', async () => {
    const f = await fixture(); const go = await f.bin('go');
    await Promise.all([fs.mkdir(path.join(f.sdk, 'pkg', 'tool'), { recursive: true }), fs.mkdir(path.join(f.sdk, 'src', 'runtime'), { recursive: true })]);
    const child = path.join(f.cwd, 'module'); await fs.mkdir(child); await fs.writeFile(path.join(child, 'go.mod'), 'module example.com/module\n');
    await fs.writeFile(path.join(f.cwd, 'go.work'), 'go 1.23\nuse ./module\n');
    const probe = vi.fn(async () => JSON.stringify({ Use: [{ DiskPath: './module' }], Replace: [] }));
    const options = { rootRealPath: f.cwd, ports: { resolve: () => go, probe } };
    const result = await prepareNativeRegressionCommand('go', child, f.sandbox, {}, options);
    expect(result.env.GOWORK).toBe(path.join(f.cwd, 'go.work')); expect(result.workspaceModuleRoots).toEqual([child]);
    expect(probe).toHaveBeenCalledOnce();
    probe.mockResolvedValueOnce(JSON.stringify({ Use: [{ DiskPath: '../sdk' }] }));
    await expect(prepareNativeRegressionCommand('go', child, f.sandbox, {}, options)).rejects.toThrow(/fora do projeto/i);
  });

  it('uses container tools and private mounted caches on Windows without host toolchain resolution', async () => {
    const resolve = vi.fn(), probe = vi.fn();
    const result = await prepareNativeRegressionCommand('cargo', 'C:\\project', 'C:\\runtime\\sandbox', {}, { platform: 'win32', ports: { resolve, probe } });
    expect(result.file).toBe('env');
    expect(result.argsPrefix).toContain('CARGO_HOME=/nexus-runtime/native/cargo');
    expect(result.argsPrefix?.at(-1)).toBe('cargo');
    expect(resolve).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    expect(result.extraReadPaths).toEqual([]);
  });

  it('refuses a project-owned toolchain probe and aborts before invoking tools', async () => {
    const f = await fixture(); const rustup = await f.bin('rustup', path.join(f.cwd, 'bin')); const probe = vi.fn();
    await expect(prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, {}, { rootRealPath: f.cwd,
      ports: { resolve: () => rustup, probe } })).rejects.toThrow(/toolchain.*projeto/i);
    const controller = new AbortController(); controller.abort();
    await expect(prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, {}, { signal: controller.signal,
      ports: { resolve: () => rustup, probe } })).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not grant the whole HOME or a broad installation prefix containing credentials', async () => {
    const f = await fixture(); const actual = { cargo: await f.bin('cargo'), rustc: await f.bin('rustc'), rustdoc: await f.bin('rustdoc') };
    const resolve = (name: string) => actual[name as keyof typeof actual] ?? null;
    await expect(prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, {}, { ports: { resolve, home: () => f.sdk } })).rejects.toThrow(/HOME/);
    const result = await prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, {}, { ports: { resolve, home: () => f.root } });
    expect(result.extraReadPaths).not.toContain(f.sdk);
    expect(result.extraReadPaths).not.toContain(path.join(f.sdk, 'share'));
  });

  it('rejects an unproved SDK root rather than granting read access to an arbitrary parent', async () => {
    const f = await fixture(); const tool = await f.bin('cargo', path.join(f.root, 'misc'));
    await expect(prepareNativeRegressionCommand('cargo', f.cwd, f.sandbox, {}, {
      ports: { resolve: () => tool, probe: vi.fn() } })).rejects.toThrow(/toolchain/i);
  });
});
