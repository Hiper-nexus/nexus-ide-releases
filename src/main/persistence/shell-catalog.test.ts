import { describe, expect, it } from 'vitest';
import { collectAvailableShells } from './shell-catalog';

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
});
