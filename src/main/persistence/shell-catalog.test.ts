import { describe, expect, it } from 'vitest';
import {
  collectAvailableShells,
  resolveConfiguredShell,
} from './shell-catalog';

describe('collectAvailableShells', () => {
  it('returns the current shell first, then executable absolute entries once', () => {
    const file = `
# valid login shells
/bin/bash
/bin/zsh
/bin/zsh
fish
/opt/homebrew/bin/fish
`;
    const executable = new Set(['/bin/zsh', '/bin/bash']);

    expect(
      collectAvailableShells(file, '/bin/zsh', (candidate) =>
        executable.has(candidate),
      ),
    ).toEqual(['/bin/zsh', '/bin/bash']);
  });

  it('keeps a valid current shell even when /etc/shells is unavailable', () => {
    expect(
      collectAvailableShells('', '/custom/bin/nu', (candidate) =>
        candidate === '/custom/bin/nu',
      ),
    ).toEqual(['/custom/bin/nu']);
  });

  it('prefers the account login shell over the raw /etc/shells order', () => {
    // macOS declara /bin/bash antes do /bin/zsh; sem o login shell da conta o
    // fallback de um app sem $SHELL abria bash pelado em vez do zsh do usuário.
    const file = `/bin/bash\n/bin/zsh\n`;
    const executable = new Set(['/bin/zsh', '/bin/bash']);

    expect(
      collectAvailableShells(
        file,
        undefined,
        (candidate) => executable.has(candidate),
        '/bin/zsh',
      ),
    ).toEqual(['/bin/zsh', '/bin/bash']);
  });

  it('falls back to common shells (zsh first) without login or env shell', () => {
    const executable = new Set(['/bin/zsh', '/bin/bash']);

    expect(
      collectAvailableShells('', undefined, (candidate) =>
        executable.has(candidate),
      ),
    ).toEqual(['/bin/zsh', '/bin/bash']);
  });
});

describe('resolveConfiguredShell', () => {
  it('uses only the main-configured executable shell', () => {
    expect(
      resolveConfiguredShell(undefined, '/bin/zsh', ['/bin/zsh', '/bin/bash']),
    ).toBe('/bin/zsh');
    expect(() =>
      resolveConfiguredShell('/bin/bash', '/bin/zsh', ['/bin/zsh', '/bin/bash']),
    ).toThrow(/does not match/i);
  });

  it('fails closed when the configured shell is no longer approved', () => {
    expect(() =>
      resolveConfiguredShell(undefined, '/tmp/untrusted', ['/bin/zsh']),
    ).toThrow(/not an approved executable/i);
  });
});
