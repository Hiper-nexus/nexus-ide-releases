import { describe, expect, it } from 'vitest';
import { assertSafePtyPrompt } from './tool-util';

describe('PTY prompt safety boundary', () => {
  it.each([
    'selection\u001b[201~\u0003echo PWNED\r',
    'selection\rwhoami',
    'selection\u0000hidden',
    'selection\u009b31mred',
  ])('rejects terminal control injection byte-for-byte', (prompt) => {
    expect(() => assertSafePtyPrompt(prompt)).toThrow(/unsafe terminal control/i);
  });

  it('allows bounded Unicode, tabs and line feeds used by normal context', () => {
    expect(assertSafePtyPrompt('Elemento: botão ✅\n\tcor: verde')).toBe(
      'Elemento: botão ✅\n\tcor: verde',
    );
  });
});
