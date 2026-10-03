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
  retryLoginShellPathIfMissed,
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

  it.skipIf(process.platform === 'win32')('F-790: escolhe o Codex mais novo, mesmo depois do primeiro PATH', () => {
    const old = path.join(binDir, 'codex');
    const recent = path.join(kimiDir, 'codex');
    fs.writeFileSync(old, '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
    fs.writeFileSync(recent, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
    expect(resolveCliBinary('codex', {
      processPath: binDir,
      effectivePath: [binDir, kimiDir].join(path.delimiter),
      home: tmp,
    })?.binPath).toBe(recent);
  });

  it.skipIf(process.platform === 'win32')('F-790: memoises successful/failed probes by real path and invalidates after mtime changes', () => {
    const old = path.join(binDir, 'codex');
    const recent = path.join(kimiDir, 'codex');
    const log = path.join(tmp, 'version-probes');
    const writeVersion = (bin: string, version: string) => fs.writeFileSync(bin,
      `#!/bin/sh\necho probe >> '${log}'\necho codex-cli ${version}\n`, { mode: 0o755 });
    const count = () => fs.readFileSync(log, 'utf8').trim().split('\n').length;
    writeVersion(old, '0.146.0'); writeVersion(recent, '0.160.0');
    const options = { processPath: binDir, effectivePath: [binDir, kimiDir].join(path.delimiter), home: tmp };
    const hit = resolveCliBinary('codex', options);
    expect(hit?.installationWarning).toBe('2 instalações: 0.146.0 e 0.160.0; usando 0.160.0');
    for (let i = 0; i < 5; i++) expect(resolveCliBinary('codex', options)?.binPath).toBe(recent);
    expect(count()).toBe(2);
    writeVersion(old, '0.170.0');
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(old, later, later);
    expect(resolveCliBinary('codex', options)?.binPath).toBe(old);
    expect(count()).toBe(3);
    fs.writeFileSync(recent, `#!/bin/sh\necho probe >> '${log}'\nexit 1\n`, { mode: 0o755 });
    fs.utimesSync(recent, later, later);
    expect(resolveCliBinary('codex', options)?.binPath).toBe(old);
    expect(resolveCliBinary('codex', options)?.binPath).toBe(old);
    expect(count()).toBe(4);
  });

  it.skipIf(process.platform === 'win32')('F-790: keeps PATH order when any candidate version is unreadable, and on equal versions', () => {
    const old = path.join(binDir, 'codex');
    const recent = path.join(kimiDir, 'codex');
    fs.writeFileSync(old, '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
    fs.writeFileSync(recent, '#!/bin/sh\necho no-version\n', { mode: 0o755 });
    const options = { processPath: binDir, effectivePath: [binDir, kimiDir].join(path.delimiter), home: tmp };
    expect(resolveCliBinary('codex', options)?.binPath).toBe(old);
    fs.writeFileSync(recent, '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
    expect(resolveCliBinary('codex', options)?.binPath).toBe(old);
    expect(resolveCliBinary('codex', options)?.installationWarning).toBeUndefined();
    // Absolute overrides remain authoritative, even when a newer PATH installation exists.
    fs.writeFileSync(recent, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
    expect(resolveCliBinary(old, options)?.binPath).toBe(old);
  });

  it.skipIf(process.platform === 'win32')('F-790: aliases of one real executable never compete or probe versions', () => {
    const bin = path.join(binDir, 'codex');
    const log = path.join(tmp, 'unexpected-probes');
    fs.writeFileSync(bin, `#!/bin/sh\necho probe >> '${log}'\n`, { mode: 0o755 });
    fs.symlinkSync(bin, path.join(kimiDir, 'codex'));
    const hit = resolveCliBinary('codex', { processPath: binDir, effectivePath: [kimiDir, binDir, kimiDir].join(path.delimiter), home: tmp });
    expect(hit?.binPath).toBe(bin);
    expect(hit?.installationWarning).toBeUndefined();
    expect(fs.existsSync(log)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('F-790: never ranks node/git or probes single installations', () => {
    const log = path.join(tmp, 'unexpected-probes');
    for (const command of ['node', 'git']) {
      for (const dir of [binDir, kimiDir]) fs.writeFileSync(path.join(dir, command), `#!/bin/sh\necho probe >> '${log}'\n`, { mode: 0o755 });
      expect(resolveCliBinary(command, { processPath: binDir, effectivePath: kimiDir, home: tmp })?.binPath).toBe(path.join(binDir, command));
    }
    expect(resolveCliBinary('claude', { processPath: binDir, effectivePath: binDir, home: tmp })?.binPath).toBe(executable);
    expect(fs.existsSync(log)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('F-790: ranks all affected AI CLIs numerically and warns without paths', () => {
    for (const command of ['claude', 'grok', 'agy']) {
      for (const [dir, version] of [[binDir, '2.1.9'], [kimiDir, '2.1.10']]) {
        fs.writeFileSync(path.join(dir, command), `#!/bin/sh\necho ${command} v${version}\n`, { mode: 0o755 });
      }
      const hit = resolveCliBinary(command, { processPath: '', effectivePath: [binDir, kimiDir].join(path.delimiter), home: tmp });
      expect(hit?.binPath).toBe(path.join(kimiDir, command));
      expect(hit?.installationWarning).toBe('2 instalações: 2.1.9 e 2.1.10; usando 2.1.10');
      expect(hit?.installationWarning).not.toContain(tmp);
    }
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

  it.skipIf(process.platform === 'win32')('F-210: recupera Claude nativo com atalho quebrado sem modificar o atalho', () => {
    const bin = path.join(tmp, '.local', 'bin');
    const versions = path.join(tmp, '.local', 'share', 'claude', 'versions');
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(versions, { recursive: true });
    for (const version of ['2.1.9', '2.1.10', '2.1.10-beta.1']) {
      fs.writeFileSync(path.join(versions, version), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(versions, '9.0.0'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(versions, '10.0.0'));
    const missing = path.join(versions, '1.0.0');
    const launcher = path.join(bin, 'claude'); fs.symlinkSync(missing, launcher);
    const options = { home: tmp, processPath: bin, effectivePath: bin };
    expect(resolveCliBinary('claude', options)).toMatchObject({ binPath: path.join(versions, '2.1.10'), source: 'fallback-dir' });
    expect(fs.readlinkSync(launcher)).toBe(missing);
    expect(resolveCliBinary('other-cli', options)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('F-210: recupera sem launcher e preserva prioridade de launcher válido', () => {
    const versions = path.join(tmp, '.local', 'share', 'claude', 'versions');
    fs.mkdirSync(versions, { recursive: true });
    const native = path.join(versions, '8.42.123');
    fs.writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveCliBinary('claude', { home: tmp, processPath: '', effectivePath: '' })?.binPath).toBe(native);
    expect(resolveCliBinary('claude', { home: tmp, processPath: binDir, effectivePath: binDir })?.binPath).toBe(executable);
  });

  it.skipIf(process.platform === 'win32')('F-210: arquivo existente sem execução e sem instalação válida continua indisponível', () => {
    fs.chmodSync(executable, 0o644);
    expect(resolveCliBinary('claude', { home: tmp, processPath: binDir, effectivePath: binDir })).toBeNull();
    expect(fs.readFileSync(executable, 'utf8')).toContain('echo ok');
  });

  it('covers version managers and legacy installers outside ~/.local/bin (multi-cliente)', () => {
    // Máquina de colega: claude via nvm/pnpm/mise/instalador antigo. Com o
    // shell de login lento (oh-my-zsh + nvm > 4 s) só as pastas fixas valem.
    const home = tmp;
    for (const version of ['v20.11.0', 'v22.23.2', 'v18.19.1']) {
      fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', version, 'bin'), { recursive: true });
    }
    const dirs = commonCliBinDirs(home);
    const nvm = dirs.filter((dir) => dir.includes(`${path.sep}.nvm${path.sep}versions`));
    expect(nvm).toEqual([
      path.join(home, '.nvm', 'versions', 'node', 'v22.23.2', 'bin'),
      path.join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'),
      path.join(home, '.nvm', 'versions', 'node', 'v18.19.1', 'bin'),
    ]);
    expect(dirs).toContain(path.join(home, '.claude', 'local'));
    expect(dirs).toContain(path.join(home, '.local', 'share', 'mise', 'shims'));
    expect(dirs).toContain(path.join(home, '.local', 'share', 'pnpm'));
    if (process.platform === 'darwin') expect(dirs).toContain(path.join(home, 'Library', 'pnpm'));
  });

  it('finds claude installed under nvm with a Finder PATH and no login shell', () => {
    const nvmBin = path.join(tmp, '.nvm', 'versions', 'node', 'v22.1.0', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });
    const extension = process.platform === 'win32' ? '.cmd' : '';
    fs.writeFileSync(path.join(nvmBin, `claude-nvm${extension}`), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const hit = resolveCliBinary(`claude-nvm${extension}`, {
      processPath: '/usr/bin:/bin',
      home: tmp,
    });
    expect(hit?.binPath).toBe(path.join(nvmBin, `claude-nvm${extension}`));
  });

  it.skipIf(process.platform === 'win32')(
    'retries a login-shell probe that timed out at boot, with a longer deadline',
    async () => {
      const originalPath = process.env.PATH;
      const timeouts: number[] = [];
      try {
      const missed = await retryLoginShellPathIfMissed(
        async (_file, _args, options) => {
          timeouts.push(options.timeout);
          return '__NEXUS_PATH_START__/late/nvm/bin__NEXUS_PATH_END__';
        },
        { home: tmp, bootProbe: '' },
      );
      expect(missed).toBe(true);
      expect(timeouts[0]).toBeGreaterThanOrEqual(15_000);
      expect(process.env.PATH?.split(path.delimiter)).toContain('/late/nvm/bin');
      } finally {
        process.env.PATH = originalPath;
      }
    },
  );

  it('does not re-probe when the boot probe already succeeded', async () => {
    let calls = 0;
    const missed = await retryLoginShellPathIfMissed(
      async () => {
        calls += 1;
        return '';
      },
      { home: tmp, bootProbe: '/usr/bin:/bin' },
    );
    expect(missed).toBe(false);
    expect(calls).toBe(0);
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
