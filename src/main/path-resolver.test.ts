import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPathResolverForTests,
  buildEffectivePath,
  commonCliBinDirs,
  lookupInPath,
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
    executable = path.join(binDir, 'claude');
    kimiBin = path.join(kimiDir, 'kimi');
    fs.writeFileSync(executable, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    fs.writeFileSync(kimiBin, '#!/bin/sh\necho kimi\n', { mode: 0o755 });
  });

  afterEach(() => {
    __resetPathResolverForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('includes ~/.kimi-code/bin among curated fallbacks', () => {
    const home = tmp;
    const dirs = commonCliBinDirs(home);
    expect(dirs).toContain(path.join(home, '.kimi-code', 'bin'));
    expect(dirs).toContain(path.join(home, '.local', 'bin'));
    expect(dirs).toContain(path.join(home, '.volta', 'bin'));
    expect(dirs).toContain(path.join(home, '.bun', 'bin'));
    expect(dirs).toContain('/opt/homebrew/bin');
  });

  it('lookupInPath finds an executable on a minimal PATH', () => {
    const found = lookupInPath('claude', binDir);
    expect(found).toBe(executable);
  });

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
    const effective = buildEffectivePath({
      processPath: '/usr/bin:/bin',
      loginPath: '/custom/login/bin',
      home: tmp,
    });
    const parts = effective.split(path.delimiter);
    expect(parts).toContain('/usr/bin');
    expect(parts).toContain('/custom/login/bin');
    expect(parts).toContain(kimiDir);
  });

  it('absolute path resolution accepts ~/ expansion', () => {
    const rel = path.join('.kimi-code', 'bin', 'kimi');
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

  it('rejects non-executable regular files', () => {
    const plain = path.join(binDir, 'not-a-cli');
    fs.writeFileSync(plain, 'data\n', { mode: 0o644 });
    expect(lookupInPath('not-a-cli', binDir)).toBeNull();
    expect(revalidateExecutable(plain)).toBe(false);
  });
});
