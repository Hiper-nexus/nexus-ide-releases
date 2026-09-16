import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPathResolverForTests,
  buildEffectivePath,
  commonCliBinDirs,
  lookupInPath,
  probeLoginShellPath,
  revalidateExecutable,
  resolveCliBinary,
  resolveSpawnBinary,
} from './path-resolver';

describe('path-resolver CLI binary resolution', () => {
  let tmp: string;
  let binDir: string;
  let kimiDir: string;
  let executable: string;
  let kimiBin: string;

  beforeEach(() => {
    __resetPathResolverForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-path-'));
    binDir = path.join(tmp, 'local-bin');
    kimiDir = path.join(tmp, '.kimi-code', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(kimiDir, { recursive: true });
    const extension = process.platform === 'win32' ? '.cmd' : '';
    executable = path.join(binDir, `claude${extension}`);
    kimiBin = path.join(kimiDir, `kimi${extension}`);
    const script =
      process.platform === 'win32'
        ? '@echo off\r\necho ok\r\n'
        : '#!/bin/sh\necho ok\n';
    fs.writeFileSync(executable, script, { mode: 0o755 });
    fs.writeFileSync(kimiBin, script, { mode: 0o755 });
  });

  afterEach(() => {
    __resetPathResolverForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('includes vendor install dirs among curated fallbacks', () => {
    const home = tmp;
    const dirs = commonCliBinDirs(home);
    expect(dirs).toContain(path.join(home, '.kimi-code', 'bin'));
    expect(dirs).toContain(path.join(home, '.grok', 'bin'));
    expect(dirs).toContain(path.join(home, '.local', 'bin'));
    expect(dirs).toContain(path.join(home, '.volta', 'bin'));
    expect(dirs).toContain(path.join(home, '.bun', 'bin'));
    expect(dirs).toContain('/opt/homebrew/opt/node@22/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
  });

  it('finds CLIs under the real account home even when $HOME is isolated', () => {
    // Mirrors real-mission E2E: disposable HOME, CLIs only in the real home.
    const isolated = path.join(tmp, 'isolated-home');
    fs.mkdirSync(isolated, { recursive: true });
    const realLocal = path.join(tmp, '.local', 'bin');
    fs.mkdirSync(realLocal, { recursive: true });
    const claude = path.join(
      realLocal,
      `claude${process.platform === 'win32' ? '.cmd' : ''}`,
    );
    fs.writeFileSync(
      claude,
      process.platform === 'win32'
        ? '@echo off\r\necho claude\r\n'
        : '#!/bin/sh\necho claude\n',
      { mode: 0o755 },
    );

    const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const effective = buildEffectivePath({
      processPath: finderPath,
      loginPath: '',
      home: tmp, // real account home (userInfo), not $HOME
    });
    const hit = resolveCliBinary('claude', {
      processPath: finderPath,
      effectivePath: effective,
      home: tmp,
    });
    expect(hit?.binPath).toBe(claude);
    // Isolated HOME would have been empty — prove we did not need it.
    expect(fs.existsSync(path.join(isolated, '.local', 'bin', 'claude'))).toBe(
      false,
    );
  });

  it('lookupInPath finds an executable on a minimal PATH', () => {
    const found = lookupInPath('claude', binDir);
    expect(found).toBe(executable);
  });

  it.skipIf(process.platform !== 'win32')(
    'prefers the Windows launcher over a same-named POSIX shim',
    () => {
      const posixShim = path.join(binDir, 'codex');
      const windowsLauncher = path.join(binDir, 'codex.cmd');
      fs.writeFileSync(posixShim, '#!/bin/sh\necho codex\n', { mode: 0o755 });
      fs.writeFileSync(windowsLauncher, '@echo off\r\necho codex\r\n');

      expect(lookupInPath('codex', binDir)).toBe(windowsLauncher);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'keeps an explicitly suffixed Windows launcher executable',
    () => {
      const windowsLauncher = path.join(binDir, 'codex.cmd');
      fs.writeFileSync(windowsLauncher, '@echo off\r\necho codex\r\n');

      expect(lookupInPath('codex.cmd', binDir)).toBe(windowsLauncher);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'does not keep a cached POSIX shim when a Windows launcher is available',
    () => {
      const posixShim = path.join(binDir, 'codex');
      const windowsLauncher = path.join(binDir, 'codex.cmd');
      fs.writeFileSync(posixShim, '#!/bin/sh\necho codex\n', { mode: 0o755 });
      fs.writeFileSync(windowsLauncher, '@echo off\r\necho codex\r\n');
      const previousPath = process.env.PATH;
      process.env.PATH = binDir;
      __resetPathResolverForTests();

      try {
        expect(resolveSpawnBinary('codex', posixShim)?.binPath).toBe(
          windowsLauncher,
        );
      } finally {
        process.env.PATH = previousPath;
        __resetPathResolverForTests();
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'resolves the npm Codex cmd shim to its adjacent native Node entry point',
    async () => {
      const shim = path.join(binDir, 'codex.cmd');
      const node = path.join(binDir, 'node.exe');
      const entry = path.join(
        binDir,
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js',
      );
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
      fs.writeFileSync(node, 'MZ');
      fs.writeFileSync(entry, '#!/usr/bin/env node\n');

      const resolver = (await import('./path-resolver')) as unknown as {
        resolveWindowsCodexNpmShimLaunch: (
          shimPath: string,
        ) => { file: string; argsPrefix: string[] } | null;
      };

      expect(resolver.resolveWindowsCodexNpmShimLaunch(shim)).toEqual({
        file: node,
        argsPrefix: [entry],
      });
    },
  );

  it('lookupInPath misses when Finder PATH has no CLI dirs', () => {
    const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    expect(lookupInPath('kimi', finderPath)).toBeNull();
    expect(lookupInPath('claude', finderPath)).toBeNull();
  });

  it('resolveCliBinary finds kimi via effective PATH when process PATH is minimal', () => {
    const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const effective = [finderPath, kimiDir, binDir].join(path.delimiter);
    const hit = resolveCliBinary('kimi', {
      processPath: finderPath,
      effectivePath: effective,
      home: tmp,
    });
    expect(hit).not.toBeNull();
    expect(hit!.binPath).toBe(kimiBin);
    expect(hit!.effectivePath).toBe(effective);
  });

  it('discovery and spawn resolve the same absolute executable', () => {
    const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const effective = [finderPath, kimiDir].join(path.delimiter);
    const discovered = resolveCliBinary('kimi', {
      processPath: finderPath,
      effectivePath: effective,
      home: tmp,
    });
    expect(discovered?.binPath).toBe(kimiBin);

    const forSpawn = resolveSpawnBinary('kimi', discovered?.binPath);
    expect(forSpawn?.binPath).toBe(kimiBin);
    expect(revalidateExecutable(forSpawn!.binPath)).toBe(true);
  });

  it('resolveSpawnBinary prefers a revalidated absolute path over bare name', () => {
    const spawn = resolveSpawnBinary('kimi', kimiBin);
    expect(spawn?.binPath).toBe(kimiBin);
    expect(spawn?.source).toBe('absolute');
  });

  it('revalidateExecutable rejects missing or non-absolute paths', () => {
    expect(revalidateExecutable('kimi')).toBe(false);
    expect(revalidateExecutable(path.join(tmp, 'missing'))).toBe(false);
    expect(revalidateExecutable(kimiBin)).toBe(true);
  });

  it('buildEffectivePath unions process + login + existing curated dirs', () => {
    // Point home at tmp so .kimi-code/bin exists and is included.
    const processPath = ['/usr/bin', '/bin'].join(path.delimiter);
    const effective = buildEffectivePath({
      processPath,
      loginPath: '/custom/login/bin',
      home: tmp,
    });
    const parts = effective.split(path.delimiter);
    expect(parts).toContain('/usr/bin');
    expect(parts).toContain('/custom/login/bin');
    expect(parts).toContain(kimiDir);
  });

  it('probes the login shell asynchronously without blocking the main process', async () => {
    const value = await probeLoginShellPath(
      async () => '__NEXUS_PATH_START__/custom/async/bin__NEXUS_PATH_END__',
      tmp,
    );

    // Windows has no POSIX login shell to probe; the resolver deliberately
    // keeps the inherited PATH unchanged there.
    if (process.platform === 'win32') expect(value).toBe(process.env.PATH ?? '');
    else expect(value).toBe('/custom/async/bin');
  });

  it('absolute path resolution accepts ~/ expansion', () => {
    const rel = path.relative(tmp, kimiBin);
    const hit = resolveCliBinary(`~/${rel}`, { home: tmp });
    expect(hit?.binPath).toBe(kimiBin);
    expect(hit?.source).toBe('absolute');
  });

  it('classifies vendor fallback hits as fallback-dir when process PATH is minimal', () => {
    const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const hit = resolveCliBinary('kimi', {
      processPath: finderPath,
      effectivePath: [finderPath, kimiDir].join(path.delimiter),
      home: tmp,
    });
    expect(hit?.source).toBe('fallback-dir');
  });

  it('resolveSpawnBinary ignores a stale preferred path and re-resolves', () => {
    const stale = path.join(tmp, 'gone', 'kimi');
    const hit = resolveSpawnBinary(kimiBin, stale);
    // preferred is invalid; absolute commandOrPath (kimiBin) still wins.
    expect(hit?.binPath).toBe(kimiBin);
  });

  it('rejects regular files that Windows cannot launch directly', () => {
    const plain = path.join(binDir, 'not-a-cli');
    fs.writeFileSync(plain, 'data\n', { mode: 0o644 });
    if (process.platform === 'win32') {
      expect(lookupInPath('not-a-cli', binDir)).toBeNull();
      expect(revalidateExecutable(plain)).toBe(false);
    } else {
      expect(lookupInPath('not-a-cli', binDir)).toBeNull();
      expect(revalidateExecutable(plain)).toBe(false);
    }
  });
});
