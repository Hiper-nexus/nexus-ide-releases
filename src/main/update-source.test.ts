import { describe, expect, it } from 'vitest';
import {
  buildSquirrelFeed,
  cmpSemver,
  macUpdateArchitecture,
  parseGhRelease,
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
