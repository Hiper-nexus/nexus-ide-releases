import { describe, expect, it } from 'vitest';
import { ensureUtf8Locale } from './pty-env-locale';

describe('ensureUtf8Locale', () => {
  it('app GUI sem LANG (Finder/macOS): injeta LANG UTF-8 pro CLI não virar mojibake', () => {
    // O caso do bug F de 05/08: empacotado lançado pelo Finder não herda
    // locale; o CLI roda em locale C e "missão" vira "miss√£o" no pane.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/Users/x' };
    ensureUtf8Locale(env, 'darwin');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('preserva locale UTF-8 já herdado', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'pt_BR.UTF-8' };
    ensureUtf8Locale(env, 'darwin');
    expect(env.LANG).toBe('pt_BR.UTF-8');
  });

  it('promove LANG=C/POSIX (quebra UTF-8 igual a ausência)', () => {
    const c: NodeJS.ProcessEnv = { LANG: 'C' };
    ensureUtf8Locale(c, 'linux');
    expect(c.LANG).toBe('en_US.UTF-8');
    const posix: NodeJS.ProcessEnv = { LANG: 'POSIX' };
    ensureUtf8Locale(posix, 'linux');
    expect(posix.LANG).toBe('en_US.UTF-8');
  });

  it('respeita LC_ALL UTF-8 vigente mesmo sem LANG', () => {
    const env: NodeJS.ProcessEnv = { LC_ALL: 'pt_BR.UTF-8' };
    ensureUtf8Locale(env, 'darwin');
    expect(env.LANG).toBeUndefined();
    expect(env.LC_ALL).toBe('pt_BR.UTF-8');
  });

  it('não toca em Windows (LANG não rege codepage lá)', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureUtf8Locale(env, 'win32');
    expect(env.LANG).toBeUndefined();
  });
});
