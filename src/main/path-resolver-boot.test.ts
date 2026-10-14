import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPathResolverForTests, lookupInPath, resolveUserPath, retryLoginShellPathIfMissed } from './path-resolver';

vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('unexpected real shell'); }) }));

describe.skipIf(process.platform === 'win32')('cached boot PATH', () => {
  let root: string;
  let cachePath: string;
  const originalPath = process.env.PATH;
  const wrap = (value: string) => `__NEXUS_PATH_START__${value}__NEXUS_PATH_END__`;
  beforeEach(() => {
    __resetPathResolverForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-boot-path-'));
    cachePath = path.join(root, 'login-path.json');
    process.env.PATH = '/usr/bin:/bin';
  });
  afterEach(() => {
    __resetPathResolverForTests();
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const writeCache = (file: string, home: string, loginPath: unknown) =>
    fs.writeFileSync(file, JSON.stringify({ platform: process.platform, home, loginPath }));

  it('uses the last good login PATH without waiting for the new probe, then rescans a newly installed nvm CLI', async () => {
    writeCache(cachePath, root, '/cached/bin');
    let finish!: (value: string) => void;
    const exec = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    await resolveUserPath({ cachePath, home: root, exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(process.env.PATH?.split(path.delimiter)).toContain('/cached/bin');
    expect(lookupInPath('nvm-test-cli', process.env.PATH!)).toBeNull();
    const nvm = path.join(root, '.nvm', 'versions', 'node', 'v22.23.2', 'bin');
    fs.mkdirSync(nvm, { recursive: true });
    const cli = path.join(nvm, 'nvm-test-cli');
    fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 });
    const rescan = vi.fn(() => lookupInPath('nvm-test-cli', process.env.PATH!));
    const revalidated = retryLoginShellPathIfMissed(exec, { home: root })
      .then((changed) => changed ? rescan() : null);
    expect(rescan).not.toHaveBeenCalled();
    finish(wrap(nvm));
    expect(await revalidated).toBe(cli);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8')).loginPath).toBe(nvm);
  });

  it.each(['missing', 'invalid-json', 'wrong-home', 'invalid-path'])('ignores %s cache and waits only for the live probe', async (kind) => {
    if (kind === 'invalid-json') fs.writeFileSync(cachePath, '{');
    if (kind === 'wrong-home') writeCache(cachePath, '/different-user', '/cached/bin');
    if (kind === 'invalid-path') writeCache(cachePath, root, 'relative/bin');
    let finish!: (value: string) => void;
    const exec = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let ready = false;
    const resolving = resolveUserPath({ cachePath, home: root, exec }).then(() => { ready = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toBe(false);
    finish(wrap('/live/bin'));
    await resolving;
    expect(process.env.PATH?.split(path.delimiter)).toContain('/live/bin');
    await retryLoginShellPathIfMissed(exec, { home: root });
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8')).loginPath).toBe('/live/bin');
  });

  it('keeps the last good cache on failure and retries the missed probe with the existing longer deadline', async () => {
    writeCache(cachePath, root, '/cached/bin');
    const exec = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(wrap('/late/bin'));
    await resolveUserPath({ cachePath, home: root, exec });
    expect(await retryLoginShellPathIfMissed(exec, { home: root })).toBe(true);
    expect(exec.mock.calls[1][2].timeout).toBe(20_000);
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8')).loginPath).toBe('/late/bin');
  });

  it('cache write failure remains non-fatal', async () => {
    fs.mkdirSync(cachePath);
    const exec = vi.fn().mockResolvedValue(wrap('/live/bin'));
    await resolveUserPath({ cachePath, home: root, exec });
    await expect(retryLoginShellPathIfMissed(exec, { home: root })).resolves.toBe(false);
    expect(process.env.PATH?.split(path.delimiter)).toContain('/live/bin');
  });

  it('does not overwrite the last good PATH when both shell attempts fail', async () => {
    writeCache(cachePath, root, '/cached/bin');
    const before = fs.readFileSync(cachePath, 'utf8');
    const exec = vi.fn().mockRejectedValue(new Error('timeout'));
    await resolveUserPath({ cachePath, home: root, exec });
    expect(await retryLoginShellPathIfMissed(exec, { home: root })).toBe(false);
    expect(fs.readFileSync(cachePath, 'utf8')).toBe(before);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('removes cached directories before rescanning so stale executables cannot shadow the fresh login PATH', async () => {
    const cached = path.join(root, 'old-bin');
    const live = path.join(root, 'new-bin');
    for (const dir of [cached, live]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'path-choice-cli'), '#!/bin/sh\n', { mode: 0o755 });
    }
    writeCache(cachePath, root, cached);
    const exec = vi.fn().mockResolvedValue(wrap(live));
    await resolveUserPath({ cachePath, home: root, exec });
    expect(lookupInPath('path-choice-cli', process.env.PATH!)).toBe(path.join(cached, 'path-choice-cli'));
    expect(await retryLoginShellPathIfMissed(exec, { home: root })).toBe(true);
    expect(lookupInPath('path-choice-cli', process.env.PATH!)).toBe(path.join(live, 'path-choice-cli'));
    expect(process.env.PATH?.split(path.delimiter)).not.toContain(cached);
    expect(process.env.PATH?.split(path.delimiter)).toContain('/usr/bin');
  });
});
