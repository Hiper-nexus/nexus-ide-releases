import { describe, expect, it } from 'vitest';
import {
  SESSION_BOUNDARY_NOTICE,
  TERMINAL_INPUT_MODE_RESET,
  terminalBufferHasContent,
  type TerminalBufferProbe,
} from './session-boundary-notice';

function bufferOf(
  lines: string[],
  baseY = 0,
): TerminalBufferProbe {
  return {
    baseY,
    length: lines.length,
    getLine: (index) =>
      index < lines.length
        ? { translateToString: () => lines[index]! }
        : undefined,
  };
}

describe('SESSION_BOUNDARY_NOTICE', () => {
  it('is a styled one-line PT-BR divider', () => {
    expect(SESSION_BOUNDARY_NOTICE).toContain(
      '── sessão anterior encerrada · nova sessão iniciada ──',
    );
    expect(SESSION_BOUNDARY_NOTICE).toContain('\x1b[90m');
    expect(SESSION_BOUNDARY_NOTICE).toContain('\x1b[0m');
  });
});

describe('terminalBufferHasContent', () => {
  it('is false for a brand-new terminal (no scrollback, blank viewport)', () => {
    expect(terminalBufferHasContent(bufferOf(['', '', '']))).toBe(false);
    expect(terminalBufferHasContent(bufferOf([]))).toBe(false);
  });

  it('is true once anything scrolled into the scrollback region', () => {
    expect(terminalBufferHasContent(bufferOf([''], 3))).toBe(true);
  });

  it('is true when any viewport row has non-blank text', () => {
    expect(terminalBufferHasContent(bufferOf(['', '  $ ls', '']))).toBe(true);
  });

  it('ignores whitespace-only rows', () => {
    expect(terminalBufferHasContent(bufferOf(['   ', '\t']))).toBe(false);
  });
});

describe('TERMINAL_INPUT_MODE_RESET', () => {
  it('desliga todos os sabores de mouse-tracking e os modos de input herdados', () => {
    // Lixo ^[[<35;64;19M no shell herdado (operador 20/08): TUI morreu com
    // mouse ligado e ninguém resetou o emulador.
    for (const mode of ['?9l', '?1000l', '?1002l', '?1003l', '?1006l', '?1015l', '?1004l', '?2004l', '?1l', '?1049l']) {
      expect(TERMINAL_INPUT_MODE_RESET).toContain(`\x1b[${mode}`);
    }
  });
});
