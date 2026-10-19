/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { platformCopy } from './platform-copy';

function setPlatform(p: NodeJS.Platform | undefined) {
  (window as { nexus?: { platform?: NodeJS.Platform } }).nexus = p
    ? { platform: p }
    : undefined;
}

afterEach(() => setPlatform(undefined));

const MAC_ONLY = /Keychain|macOS|\bMac\b|Finder|\/Applications/;

describe('textos por sistema operacional (F-1579)', () => {
  it('no Windows nomeia o cofre e o Explorador de Arquivos, nunca o Keychain ou o Finder', () => {
    setPlatform('win32');
    const copy = platformCopy();
    expect(copy.vault).toBe('cofre do Windows');
    expect(copy.revealInFileManager).toBe('Mostrar no Explorador de Arquivos');
    expect(copy.canOpenSoundSettings).toBe(true);
    expect(copy.canResetMicPermission).toBe(false);
    for (const value of Object.values(copy)) {
      if (typeof value === 'string') expect(value).not.toMatch(MAC_ONLY);
    }
  });

  it('no Linux fala do chaveiro do sistema e esconde as telas de Ajustes', () => {
    setPlatform('linux');
    const copy = platformCopy();
    expect(copy.vault).toBe('chaveiro do sistema');
    expect(copy.revealInFileManager).toBe('Mostrar na pasta');
    expect(copy.canOpenSoundSettings).toBe(false);
    for (const value of Object.values(copy)) {
      if (typeof value === 'string') expect(value).not.toMatch(MAC_ONLY);
    }
  });

  it('no Mac mantém os nomes do macOS', () => {
    setPlatform('darwin');
    const copy = platformCopy();
    expect(copy.vault).toBe('Keychain');
    expect(copy.revealInFileManager).toBe('Mostrar no Finder');
    expect(copy.canResetMicPermission).toBe(true);
    expect(copy.vaultCaution).toContain('Reajustar Para Padrões');
  });

  it('aceita a plataforma explícita sem ler a ponte', () => {
    setPlatform('darwin');
    expect(platformCopy('windows').fileManager).toBe('Explorador de Arquivos');
  });
});
