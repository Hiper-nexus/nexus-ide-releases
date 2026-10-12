import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyProjectNodeToWorkerPath,
  candidateNodeBinDirs,
  detectPinnedNodeMajor,
  majorFromVersion,
  resolveInstalledNodeBin,
} from './node-version-path';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-node-'));
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** deps que lê de um projeto em disco, com candidatos de bin controlados. */
function depsFor(_projectRoot: string, binDirs: string[]): Parameters<typeof applyProjectNodeToWorkerPath>[2] {
  return {
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    candidateDirs: () => binDirs,
    dirExists: (dir) => binDirs.includes(dir),
    platform: 'darwin',
  };
}

describe('F-1385 — Node fixado pelo projeto entra no PATH do worker', () => {
  it('.nvmrc = 22 e um node@22/bin falso: PATH começa pelo bin falso', () => {
    const root = tmpRoot();
    const fakeBin = path.join(root, 'fake', 'node@22', 'bin');
    write(root, { '.nvmrc': '22\n' });
    fs.mkdirSync(fakeBin, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const info = applyProjectNodeToWorkerPath(env, root, depsFor(root, [fakeBin]));
    expect(info.applied).toBe(true);
    expect(info.binDir).toBe(fakeBin);
    expect(info.major).toBe('22');
    expect(env.PATH).toBe(`${fakeBin}:/usr/bin:/bin`);
  });

  it('sem .nvmrc (projeto sem pin): PATH inalterado', () => {
    const root = tmpRoot();
    write(root, { 'src/index.ts': '' });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const info = applyProjectNodeToWorkerPath(env, root, depsFor(root, []));
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('no-pinned-node');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('sem Node compatível instalado: PATH inalterado e motivo registrado', () => {
    const root = tmpRoot();
    write(root, { '.nvmrc': '22\n' });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const info = applyProjectNodeToWorkerPath(env, root, depsFor(root, []));
    expect(info.applied).toBe(false);
    expect(info.major).toBe('22');
    expect(info.reason).toBe('no-compatible-node-installed');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('PATH vazio (não definido) ainda recebe o bin', () => {
    const root = tmpRoot();
    const fakeBin = path.join(root, 'fake', 'node@22', 'bin');
    write(root, { '.nvmrc': '22\n' });
    fs.mkdirSync(fakeBin, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    applyProjectNodeToWorkerPath(env, root, depsFor(root, [fakeBin]));
    expect(env.PATH).toBe(fakeBin);
  });
});

describe('F-1385 — detecção do pin', () => {
  it('majorFromVersion extrai de versões e faixas', () => {
    expect(majorFromVersion('22')).toBe('22');
    expect(majorFromVersion('22.11.0')).toBe('22');
    expect(majorFromVersion('v22.11.0')).toBe('22');
    expect(majorFromVersion('>=22.12.0 <23')).toBe('22');
    expect(majorFromVersion('lts/iron')).toBeNull();
    expect(majorFromVersion('node')).toBeNull();
    expect(majorFromVersion('')).toBeNull();
  });

  it('detecta .nvmrc antes de .node-version e package.json', () => {
    const root = tmpRoot();
    write(root, {
      '.nvmrc': '22\n',
      '.node-version': '20\n',
      'package.json': JSON.stringify({
        nexusRelease: { node: '18.20.4' },
        engines: { node: '>=20 <21' },
      }),
    });
    expect(detectPinnedNodeMajor(root)).toEqual({ major: '22', source: '.nvmrc' });
  });

  it('cai no nexusRelease.node e depois em engines.node', () => {
    const root = tmpRoot();
    write(root, {
      'package.json': JSON.stringify({
        nexusRelease: { node: '22.23.2' },
        engines: { node: '>=22.12.0 <23' },
      }),
    });
    expect(detectPinnedNodeMajor(root)).toEqual({
      major: '22',
      source: 'package.json#nexusRelease.node',
    });

    const enginesOnly = tmpRoot();
    write(enginesOnly, {
      'package.json': JSON.stringify({ engines: { node: '>=22.12.0 <23' } }),
    });
    expect(detectPinnedNodeMajor(enginesOnly)).toEqual({
      major: '22',
      source: 'package.json#engines.node',
    });
  });

  it('package.json sem declaração de node devolve null', () => {
    const root = tmpRoot();
    write(root, { 'package.json': JSON.stringify({ name: 'x' }) });
    expect(detectPinnedNodeMajor(root)).toBeNull();
  });
});

describe('F-1385 — resolução do bin instalado', () => {
  it('candidateNodeBinDirs cobre homebrew (arm64/intel/linux) e nada no win32', () => {
    const dirs = candidateNodeBinDirs('22', '/Users/x', 'darwin');
    expect(dirs).toContain('/opt/homebrew/opt/node@22/bin');
    expect(dirs).toContain('/usr/local/opt/node@22/bin');
    expect(dirs).toContain('/home/linuxbrew/.linuxbrew/opt/node@22/bin');
    expect(candidateNodeBinDirs('22', '/Users/x', 'win32')).toEqual([]);
  });

  it('resolveInstalledNodeBin devolve o primeiro candidato que existe', () => {
    const root = tmpRoot();
    const fake = path.join(root, 'node@22', 'bin');
    fs.mkdirSync(fake, { recursive: true });
    expect(
      resolveInstalledNodeBin('22', {
        candidateDirs: () => [path.join(root, 'missing'), fake],
        dirExists: (d) => d === fake,
        platform: 'darwin',
      }),
    ).toBe(fake);
    expect(
      resolveInstalledNodeBin('22', {
        candidateDirs: () => [],
        platform: 'darwin',
      }),
    ).toBeNull();
  });
});
