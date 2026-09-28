import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedNodeBinDir, pinnedNodeMajor, sanitizedTestEnv } from './regression-gate';

// 28/09: o portão rodou a suíte com o Node 26 do PATH do app enquanto o
// better-sqlite3 é compilado para o Node 22 pinado → ERR_DLOPEN_FAILED e
// reprovação de trabalho são. O runner tem de usar o Node do projeto.
describe('portão de regressão — Node pinado pelo projeto', () => {
  it('lê o major de nexusRelease.node ou engines.node', () => {
    expect(pinnedNodeMajor({ nexusRelease: { node: '22.23.2' } })).toBe(22);
    expect(pinnedNodeMajor({ engines: { node: '>=20 <23' } })).toBe(20);
    expect(pinnedNodeMajor({ engines: { node: '^18.17.0' } })).toBe(18);
    expect(pinnedNodeMajor({})).toBeNull();
    expect(pinnedNodeMajor(null)).toBeNull();
  });

  it('prefere o Homebrew node@N, senão o nvm mais novo do major; sem pino ou binário, nada', () => {
    const pkg = { nexusRelease: { node: '22.23.2' } };
    const brew = '/opt/homebrew/opt/node@22/bin';
    expect(
      pinnedNodeBinDir('/repo', { readPackage: () => pkg, hasNode: (dir) => dir === brew, listDir: () => [] }),
    ).toBe(brew);
    const nvm = path.join('/home/op', '.nvm', 'versions', 'node');
    expect(
      pinnedNodeBinDir('/repo', {
        readPackage: () => pkg,
        home: '/home/op',
        hasNode: (dir) => dir.startsWith(nvm),
        listDir: (dir) => (dir === nvm ? ['v20.5.0', 'v22.1.0', 'v22.12.0', 'v23.0.0'] : []),
      }),
    ).toBe(path.join(nvm, 'v22.12.0', 'bin'));
    expect(pinnedNodeBinDir('/repo', { readPackage: () => pkg, hasNode: () => false, listDir: () => [] })).toBeNull();
    expect(pinnedNodeBinDir('/repo', { readPackage: () => ({}), hasNode: () => true, listDir: () => [] })).toBeNull();
  });

  it('o env do runner põe o Node pinado na frente do PATH e continua sem segredos', () => {
    const env = sanitizedTestEnv('/repo', {
      readPackage: () => ({ nexusRelease: { node: '22.23.2' } }),
      hasNode: (dir) => dir === '/opt/homebrew/opt/node@22/bin',
      listDir: () => [],
    });
    expect(env.PATH?.split(path.delimiter)[0]).toBe('/opt/homebrew/opt/node@22/bin');
    expect(env.NEXUS_MCP_TOKEN).toBeUndefined();
    expect(env.CI).toBe('1');
  });
});
