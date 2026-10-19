import { describe, expect, it, vi } from 'vitest';
import {
  SHOT_APP_PATH,
  SHOT_CODE_REQUIREMENT,
  ensureShotMinVersion,
  isOfficialShotAssetUrl,
  parseShotFeed,
  type ShotInstallerDeps,
  type ShotRunResult,
} from './shot-installer';

const ASSET = 'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/v0.1.15/Nexus.Shot.app.tar.gz';
const feed = (version = '0.1.15', url = ASSET) =>
  JSON.stringify({ version, platforms: { 'darwin-aarch64': { url } } });
const ok: ShotRunResult = { code: 0, stdout: '', stderr: '' };

function makeDeps(over: Partial<ShotInstallerDeps> & { installed?: string; fresh?: string } = {}) {
  const renames: Array<[string, string]> = [];
  const deps: ShotInstallerDeps = {
    platform: 'darwin',
    arch: 'arm64',
    appPath: SHOT_APP_PATH,
    appExists: () => true,
    readBundleVersion: async (p) => (p === SHOT_APP_PATH ? (over.installed ?? '0.1.14') : (over.fresh ?? '0.1.15')),
    isShotRunning: async () => false,
    hasRecentShotCrash: () => false,
    fetchText: async () => feed(),
    downloadTo: async () => {},
    run: async () => ok,
    makeStagingDir: () => '/Applications/.stg',
    rename: (a, b) => void renames.push([a, b]),
    remove: () => {},
    log: () => {},
    ...over,
  };
  return { deps, renames };
}

describe('ensureShotMinVersion', () => {
  it('substitui o Shot 0.1.14 pelo bundle verificado do feed', async () => {
    const { deps, renames } = makeDeps();
    expect(await ensureShotMinVersion(deps)).toEqual({ status: 'updated', from: '0.1.14', to: '0.1.15' });
    expect(renames).toEqual([
      [SHOT_APP_PATH, '/Applications/.stg/old.app'],
      ['/Applications/.stg/Nexus Shot.app', SHOT_APP_PATH],
    ]);
  });

  it('valida Team ID e bundle id pelo requisito do codesign, não pelo texto', async () => {
    const calls: string[][] = [];
    const { deps } = makeDeps({ run: async (_c, a) => (calls.push(a), ok) });
    expect((await ensureShotMinVersion(deps)).status).toBe('updated');
    const verify = calls.find((a) => a.includes('--verify'));
    expect(verify).toContain(`-R=${SHOT_CODE_REQUIREMENT}`);
    expect(SHOT_CODE_REQUIREMENT).toBe(
      'anchor apple generic and identifier "com.nexuside.shot" and certificate leaf[subject.OU] = "35P5XL3JN6"',
    );
    expect(calls.some((a) => a[0] === '-dv')).toBe(false);
  });

  it('recusa bundle fora do requisito ou sem notarização sem tocar na instalação', async () => {
    for (const bad of ['--verify', '--assess']) {
      const { deps, renames } = makeDeps({
        run: async (_c, a) => (a.includes(bad) ? { code: 3, stdout: '', stderr: 'rejected' } : ok),
      });
      expect((await ensureShotMinVersion(deps)).status).toBe('failed');
      expect(renames).toEqual([]);
    }
  });

  it('não apaga o staging (onde ficou o app antigo) se troca e restauração falharem', async () => {
    const removed: string[] = [];
    const { deps } = makeDeps({
      rename: (a: string) => {
        if (a.endsWith('Nexus Shot.app') || a.endsWith('old.app')) throw new Error('EPERM');
      },
      remove: (p: string) => void removed.push(p),
    });
    expect((await ensureShotMinVersion(deps)).status).toBe('failed');
    expect(removed).toEqual([]);
  });

  it.each([
    'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/../../../evil/x/releases/download/v1/a.tar.gz',
    'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/%2e%2e/%2e%2e/evil/a.tar.gz',
    'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/v1/..%2fa.tar.gz',
  ])('recusa URL de asset que escapa do repo oficial: %s', (url) => {
    expect(isOfficialShotAssetUrl(url)).toBe(false);
    expect(parseShotFeed(feed('0.1.16', url), 'arm64')).toBeNull();
  });

  it('aceita o asset oficial', () => {
    expect(isOfficialShotAssetUrl(ASSET)).toBe(true);
  });

  it('restaura o app antigo se a troca falhar no meio', async () => {
    const { deps, renames } = makeDeps({
      rename: vi.fn((a: string, b: string) => {
        renames.push([a, b]);
        if (b === SHOT_APP_PATH && a.endsWith('Nexus Shot.app')) throw new Error('EPERM');
      }),
    });
    const renames2 = renames;
    expect((await ensureShotMinVersion(deps)).status).toBe('failed');
    expect(renames2.at(-1)).toEqual(['/Applications/.stg/old.app', SHOT_APP_PATH]);
  });

  it('não faz nada quando já está no mínimo, não instalado, rodando ou fora do macOS', async () => {
    const run = vi.fn();
    expect(await ensureShotMinVersion(makeDeps({ installed: '0.1.15', run }).deps)).toEqual({ status: 'skipped', reason: 'up-to-date' });
    expect(await ensureShotMinVersion(makeDeps({ appExists: () => false, run }).deps)).toEqual({ status: 'skipped', reason: 'not-installed' });
    expect(await ensureShotMinVersion(makeDeps({ isShotRunning: async () => true, run }).deps)).toEqual({ status: 'skipped', reason: 'running' });
    expect(await ensureShotMinVersion(makeDeps({ platform: 'linux', run }).deps)).toEqual({ status: 'skipped', reason: 'not-darwin' });
    expect(run).not.toHaveBeenCalled();
  });

  it('feed ainda na 0.1.14 não troca nada', async () => {
    const { deps, renames } = makeDeps({ fetchText: async () => feed('0.1.14') });
    expect((await ensureShotMinVersion(deps)).status).toBe('failed');
    expect(renames).toEqual([]);
  });

  it('crash recente com versão no mínimo só atualiza se o feed for mais novo', async () => {
    const same = makeDeps({ installed: '0.1.15', hasRecentShotCrash: () => true });
    expect((await ensureShotMinVersion(same.deps)).status).toBe('failed');
    const newer = makeDeps({
      installed: '0.1.15',
      fresh: '0.1.16',
      hasRecentShotCrash: () => true,
      fetchText: async () => feed('0.1.16'),
    });
    expect(await ensureShotMinVersion(newer.deps)).toMatchObject({ status: 'updated', to: '0.1.16' });
  });
});

describe('parseShotFeed', () => {
  it('só aceita asset do repo oficial e escolhe a chave pela arquitetura', () => {
    expect(parseShotFeed(feed(), 'arm64')?.url).toBe(ASSET);
    expect(parseShotFeed(feed(), 'x64')).toBeNull();
    expect(parseShotFeed(feed('0.1.15', 'https://evil.example/a.tar.gz'), 'arm64')).toBeNull();
    expect(parseShotFeed('not json', 'arm64')).toBeNull();
  });
});
