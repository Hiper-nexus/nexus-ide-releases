import { describe, expect, it } from 'vitest';
import {
  buildSquirrelFeed,
  cmpSemver,
  macUpdateArchitecture,
  parseGhRelease,
  parseGhReleases,
  parseLinuxReleases,
} from './update-source';

const RELEASE = {
  tagName: 'v0.9.0',
  publishedAt: '2026-07-06T20:00:00Z',
  body: '## Novidades\n- JARVIS operacional',
  assets: [
    { name: 'NexusIDE-0.9.0-arm64.dmg' },
    { name: 'NexusIDE-darwin-arm64-0.9.0.zip' },
    { name: 'NexusIDE-darwin-x64-0.9.0.zip' },
  ],
};

describe('cmpSemver', () => {
  it('compara maior/menor/igual e tolera prefixo v', () => {
    expect(cmpSemver('0.8.2', '0.8.1')).toBeGreaterThan(0);
    expect(cmpSemver('v0.8.2', '0.8.2')).toBe(0);
    expect(cmpSemver('0.8.2', 'v0.10.0')).toBeLessThan(0);
    expect(cmpSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('trata componentes ausentes como zero', () => {
    expect(cmpSemver('1.0', '1.0.0')).toBe(0);
    expect(cmpSemver('1', '1.0.1')).toBeLessThan(0);
  });
});

describe('parseGhRelease', () => {
  it('extrai versão nova com o zip darwin-arm64', () => {
    const parsed = parseGhRelease(
      JSON.stringify(RELEASE),
      '0.8.2',
      'arm64',
      'darwin',
    );
    expect(parsed).toMatchObject({
      version: '0.9.0',
      tag: 'v0.9.0',
      zipAsset: 'NexusIDE-darwin-arm64-0.9.0.zip',
      publishedAt: '2026-07-06T20:00:00Z',
    });
    expect(parsed?.notes).toContain('JARVIS operacional');
  });

  it('retorna null quando a versão não é mais nova', () => {
    expect(
      parseGhRelease(JSON.stringify(RELEASE), '0.9.0', 'arm64', 'darwin'),
    ).toBeNull();
    expect(
      parseGhRelease(JSON.stringify(RELEASE), '1.0.0', 'arm64', 'darwin'),
    ).toBeNull();
  });

  it('retorna null sem zip darwin-arm64 ou com JSON inválido', () => {
    const noZip = { ...RELEASE, assets: [{ name: 'NexusIDE-0.9.0-arm64.dmg' }] };
    expect(
      parseGhRelease(JSON.stringify(noZip), '0.8.2', 'arm64', 'darwin'),
    ).toBeNull();
    expect(
      parseGhRelease('{{{lixo', '0.8.2', 'arm64', 'darwin'),
    ).toBeNull();
    expect(
      parseGhRelease(JSON.stringify({}), '0.8.2', 'arm64', 'darwin'),
    ).toBeNull();
  });

  it('selects only the updater ZIP matching the running Mac architecture', () => {
    expect(
      parseGhRelease(JSON.stringify(RELEASE), '0.8.2', 'x64', 'darwin'),
    ).toMatchObject({ zipAsset: 'NexusIDE-darwin-x64-0.9.0.zip' });
    expect(
      parseGhRelease(
        JSON.stringify({
          ...RELEASE,
          assets: [{ name: 'NexusIDE-darwin-arm64-0.9.0.zip' }],
        }),
        '0.8.2',
        'x64',
        'darwin',
      ),
    ).toBeNull();
  });

  it('does not select a payload for an unsupported runtime architecture', () => {
    expect(macUpdateArchitecture('arm64')).toBe('arm64');
    expect(macUpdateArchitecture('x64')).toBe('x64');
    expect(macUpdateArchitecture('ia32')).toBeNull();
    expect(
      parseGhRelease(JSON.stringify(RELEASE), '0.8.2', 'ia32', 'darwin'),
    ).toBeNull();
  });

  it.each(['linux', 'win32'] as const)(
    'never selects the macOS updater payload while running on %s',
    (platform) => {
      expect(
        parseGhRelease(JSON.stringify(RELEASE), '0.8.2', 'x64', platform),
      ).toBeNull();
    },
  );

  it('uses the real platform by default instead of inferring macOS from x64', () => {
    const parsed = parseGhRelease(JSON.stringify(RELEASE), '0.8.2', 'x64');
    if (process.platform === 'darwin') {
      expect(parsed).not.toBeNull();
    } else {
      expect(parsed).toBeNull();
    }
  });

  it('trunca notas longas', () => {
    const longBody = { ...RELEASE, body: 'x'.repeat(2000) };
    const parsed = parseGhRelease(
      JSON.stringify(longBody),
      '0.8.2',
      'arm64',
      'darwin',
    );
    expect(parsed?.notes?.length).toBeLessThanOrEqual(600);
  });
});

describe('parseGhReleases', () => {
  const apiRelease = (
    version: string,
    options: {
      draft?: boolean;
      prerelease?: boolean;
      arches?: Array<'arm64' | 'x64'>;
    } = {},
  ) => ({
    tag_name: `v${version}`,
    published_at: `2026-07-${version === '0.16.4' ? '15' : '14'}T20:00:00Z`,
    body: `Notas ${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: (options.arches ?? ['arm64', 'x64']).map((arch) => ({
      name: `NexusIDE-darwin-${arch}-${version}.zip`,
    })),
  });

  it('leva uma instalação antiga direto à maior versão compatível, independentemente da ordem', () => {
    const releases = [
      apiRelease('0.16.1'),
      apiRelease('0.15.17'),
      apiRelease('0.16.4'),
      apiRelease('0.16.3'),
    ];

    expect(
      parseGhReleases(JSON.stringify(releases), '0.15.0', 'arm64', 'darwin'),
    ).toMatchObject({
      version: '0.16.4',
      tag: 'v0.16.4',
      zipAsset: 'NexusIDE-darwin-arm64-0.16.4.zip',
    });
    expect(
      parseGhReleases(
        JSON.stringify(releases.reverse()),
        '0.15.0',
        'arm64',
        'darwin',
      ),
    ).toMatchObject({ version: '0.16.4' });
  });

  it('ignora drafts, prereleases e releases sem payload da arquitetura atual', () => {
    const releases = [
      apiRelease('0.99.0', { draft: true }),
      apiRelease('0.18.0', { prerelease: true }),
      {
        ...apiRelease('0.17.1'),
        assets: [{ name: 'NexusIDE-darwin-x64-0.16.4.zip' }],
      },
      apiRelease('0.17.0', { arches: ['arm64'] }),
      apiRelease('0.16.4'),
    ];

    expect(
      parseGhReleases(JSON.stringify(releases), '0.15.0', 'x64', 'darwin'),
    ).toMatchObject({
      version: '0.16.4',
      zipAsset: 'NexusIDE-darwin-x64-0.16.4.zip',
    });
  });
});

describe('buildSquirrelFeed', () => {
  it('gera o JSON do feed com url/name/notes/pub_date', () => {
    const parsed = parseGhRelease(
      JSON.stringify(RELEASE),
      '0.8.2',
      'arm64',
      'darwin',
    )!;
    const feed = JSON.parse(
      buildSquirrelFeed(parsed, 'http://127.0.0.1:5555/update.zip'),
    );
    expect(feed).toEqual({
      url: 'http://127.0.0.1:5555/update.zip',
      name: 'v0.9.0',
      notes: expect.stringContaining('JARVIS'),
      pub_date: '2026-07-06T20:00:00Z',
    });
  });
});

describe('parseLinuxReleases (F-751)', () => {
  const linuxAssets = (version: string) => [
    { name: `nexus-ide_${version}_amd64.deb` },
    { name: `nexus-ide-${version}-1.x86_64.rpm` },
    { name: `NexusIDE-linux-x64-${version}.zip` },
    { name: 'SHA256SUMS-linux-x64.txt' },
  ];
  const release = (version: string, assets: Array<{ name: string }>, extra: object = {}) => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-10-02T15:00:19Z',
    body: `notas da ${version}`,
    assets,
    ...extra,
  });

  it('picks the newest stable release that carries all three Linux packages', () => {
    const raw = JSON.stringify([
      release('0.76.176', [{ name: 'NexusIDE-0.76.176-win32-x64-Setup.exe' }]),
      release('0.76.175', linuxAssets('0.76.175')),
      release('0.76.170', linuxAssets('0.76.170')),
    ]);
    expect(parseLinuxReleases(raw, '0.76.170', 'x64')).toEqual({
      version: '0.76.175',
      tag: 'v0.76.175',
      publishedAt: '2026-10-02T15:00:19Z',
      notes: 'notas da 0.76.175',
    });
  });

  it('is up to date when the only newer releases are Windows or macOS builds', () => {
    // O canal Linux é independente: 0.76.176 só de Windows não é atualização.
    const raw = JSON.stringify([
      release('0.76.176', [{ name: 'NexusIDE-0.76.176-win32-x64-Setup.exe' }]),
      release('0.76.175', linuxAssets('0.76.175')),
    ]);
    expect(parseLinuxReleases(raw, '0.76.175', 'x64')).toBeNull();
  });

  it('ignores a publication still missing one of the packages', () => {
    // Foi o estado do espelho no meio da publicação da 0.76.175: só .deb e .rpm.
    const partial = linuxAssets('0.76.177').slice(0, 2);
    expect(parseLinuxReleases(JSON.stringify([release('0.76.177', partial)]), '0.76.175', 'x64')).toBeNull();
  });

  it('ignores drafts, prereleases, non-stable tags and other architectures', () => {
    const raw = JSON.stringify([
      release('0.76.180', linuxAssets('0.76.180'), { draft: true }),
      release('0.76.179', linuxAssets('0.76.179'), { prerelease: true }),
      { ...release('0.76.178', linuxAssets('0.76.178')), tag_name: 'v0.76.178-rc.1' },
    ]);
    expect(parseLinuxReleases(raw, '0.76.175', 'x64')).toBeNull();
    expect(
      parseLinuxReleases(JSON.stringify([release('0.76.177', linuxAssets('0.76.177'))]), '0.76.175', 'arm64'),
    ).toBeNull();
  });

  it('never throws on malformed input', () => {
    for (const raw of ['', 'not json', '{}', 'null', '[1,"x",null,{}]']) {
      expect(parseLinuxReleases(raw, '0.76.175', 'x64')).toBeNull();
    }
  });
});
