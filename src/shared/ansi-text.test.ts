import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi-text';

// Prefixo REAL capturado do Codex CLI 0.162.1 num PTY gravado (F-1406):
// ESC[?2004h (bracketed paste) → ESC[>4;0m (XTMODKEYS reset) → ESC[>7u
// (kitty keyboard push) → ESC[?1004h (focus reporting) → consultas de
// terminal (ESC[6n, OSC 10/11, ESC[c, ESC[?u) e ESC[?2026h (sync output).
const CODEX_0162_BOOT_PREFIX =
  '\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h\x1b[6n\x1b]10;?\x1b\\' +
  '\x1b]11;?\x1b\\\x1b[?u\x1b[c\x1b[?2026h\x1b[?2026l\x1b[?2026h';

describe('stripAnsi (F-1406: CSI com parâmetro privado)', () => {
  it('remove XTMODKEYS (ESC[>4;0m) e kitty keyboard (ESC[>7u) do boot do Codex 0.162', () => {
    const clean = stripAnsi(`${CODEX_0162_BOOT_PREFIX}>_ OpenAI Codex`);
    expect(clean).not.toContain('>4;0m');
    expect(clean).not.toContain('>7u');
    expect(clean).toBe('>_ OpenAI Codex');
  });

  it('remove CSI com os demais prefixos privados (< e =) sem tocar no texto', () => {
    expect(stripAnsi('\x1b[=5;1mTexto\x1b[<0;1m visível\x1b[m')).toBe('Texto visível');
  });

  it('mantém o comportamento das sequências comuns: cores, OSC, cursor e controles', () => {
    expect(stripAnsi('\x1b[1;31mok\x1b[0m\x1b]0;título\x07fim\x1b[2K')).toBe('okfim');
    expect(stripAnsi('linha\r\nquebrada')).toBe('linha\nquebrada');
  });
});
