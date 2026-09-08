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
    ensureUtf8Locale(env, 'darwin', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
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
    ensureUtf8Locale(env, 'darwin', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
    expect(env.LANG).toBeUndefined();
    expect(env.LC_ALL).toBe('pt_BR.UTF-8');
  });

  it('LC_ALL=C derruba o LANG UTF-8 — precedência POSIX exige limpar', () => {
    // LC_ALL > LC_CTYPE > LANG: com LC_ALL=C herdado, injetar LANG UTF-8 não
    // salva ninguém — o filho continua decodificando byte a byte e o prompt
    // pt-BR volta como "n√£o".
    const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
    ensureUtf8Locale(env, 'darwin');
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('LC_CTYPE=C não pode vencer um LANG UTF-8 legítimo do usuário', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'pt_BR.UTF-8', LC_CTYPE: 'POSIX' };
    ensureUtf8Locale(env, 'linux', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.LANG).toBe('pt_BR.UTF-8');
  });

  it('respeita LC_CTYPE UTF-8 explícito do usuário', () => {
    const env: NodeJS.ProcessEnv = { LC_CTYPE: 'pt_BR.UTF-8' };
    ensureUtf8Locale(env, 'darwin', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
    expect(env.LC_CTYPE).toBe('pt_BR.UTF-8');
    expect(env.LANG).toBeUndefined();
  });

  it('não toca em Windows (LANG não rege codepage lá)', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureUtf8Locale(env, 'win32');
    expect(env.LANG).toBeUndefined();
  });

  it('troca LANG UTF-8 inexistente (en_BR) pelo fallback', () => {
    // Campo em 07/09/2026: shell com LANG=en_BR.UTF-8 (idioma en + região
    // BR) — termina em UTF-8 mas não existe no `locale -a`, e todo boot de
    // worker cuspia warnings de perl. Sufixo não é prova; só instalado vale.
    const env: NodeJS.ProcessEnv = { LANG: 'en_BR.UTF-8' };
    ensureUtf8Locale(env, 'darwin', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('LC_ALL inexistente não derruba LANG válido', () => {
    const env: NodeJS.ProcessEnv = {
      LC_ALL: 'en_BR.UTF-8',
      LANG: 'pt_BR.UTF-8',
    };
    ensureUtf8Locale(env, 'darwin', {
      listLocales: () => ['en_US.UTF-8', 'pt_BR.UTF-8'],
    });
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LANG).toBe('pt_BR.UTF-8');
  });

  it('sem como verificar, confia no herdado (fail-open)', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'en_BR.UTF-8' };
    ensureUtf8Locale(env, 'darwin', { listLocales: () => null });
    expect(env.LANG).toBe('en_BR.UTF-8');
  });

  it('lister que lança não quebra o spawn', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'en_BR.UTF-8' };
    expect(() =>
      ensureUtf8Locale(env, 'darwin', {
        listLocales: () => {
          throw new Error('sem locale');
        },
      }),
    ).not.toThrow();
    expect(env.LANG).toBe('en_BR.UTF-8');
  });
});
