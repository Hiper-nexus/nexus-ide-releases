import { describe, expect, it } from 'vitest';
import {
  canReplayScrollback,
  terminalGridChanged,
  terminalOutputPolicy,
  terminalScrollbackLines,
} from './terminal-render-policy';

describe('terminal render policy', () => {
  it('coalesces focused agent output but keeps focused shells immediate', () => {
    expect(
      terminalOutputPolicy({
        kind: 'cli-agent',
        isFocused: true,
        isPaneVisible: true,
        isDocumentVisible: true,
        performanceMode: 'adaptive',
      }),
    ).toEqual({
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true,
      holdForeground: false,
      holdBackground: false,
    });
    expect(
      terminalOutputPolicy({
        kind: 'shell',
        isFocused: true,
        isPaneVisible: true,
        isDocumentVisible: true,
        performanceMode: 'adaptive',
      }),
    ).toEqual({
      foreground: true,
      latencySensitive: true,
      coalesceForeground: false,
      holdForeground: false,
      holdBackground: false,
    });
  });

  it('treats every pane as background while the app is hidden', () => {
    expect(
      terminalOutputPolicy({
        kind: 'cli-agent',
        isFocused: true,
        isPaneVisible: true,
        isDocumentVisible: false,
        performanceMode: 'adaptive',
      }),
    ).toEqual({
      foreground: false,
      latencySensitive: false,
      coalesceForeground: false,
      holdForeground: false,
      holdBackground: true,
    });
  });

  it('does not treat an off-screen focused pane as foreground', () => {
    expect(
      terminalOutputPolicy({
        kind: 'cli-agent',
        isFocused: true,
        isPaneVisible: false,
        isDocumentVisible: true,
        performanceMode: 'adaptive',
      }),
    ).toMatchObject({
      foreground: false,
      holdBackground: true,
    });
  });

  it('keeps hidden panes draining in quality mode', () => {
    expect(
      terminalOutputPolicy({
        kind: 'cli-agent',
        isFocused: false,
        isPaneVisible: false,
        isDocumentVisible: true,
        performanceMode: 'quality',
      }).holdBackground,
    ).toBe(false);
  });

  it('propagates terminal size only when the PTY grid changed', () => {
    expect(terminalGridChanged(null, { cols: 120, rows: 40 })).toBe(true);
    expect(
      terminalGridChanged(
        { cols: 120, rows: 40 },
        { cols: 120, rows: 40 },
      ),
    ).toBe(false);
    expect(
      terminalGridChanged(
        { cols: 120, rows: 40 },
        { cols: 121, rows: 40 },
      ),
    ).toBe(true);
  });

  it('uses a smaller scrollback budget in adaptive mode', () => {
    expect(terminalScrollbackLines('cli-agent', 'adaptive')).toBe(3_000);
    expect(terminalScrollbackLines('shell', 'adaptive')).toBe(6_000);
    expect(terminalScrollbackLines('cli-agent', 'quality')).toBe(5_000);
    expect(terminalScrollbackLines('shell', 'quality')).toBe(10_000);
  });
});

describe('canReplayScrollback', () => {
  it('permite o replay quando a largura de captura sobrevive', () => {
    expect(canReplayScrollback(96, 96)).toBe(true);
  });

  it('recusa o replay quando a grade encolheu', () => {
    // Bug real: o painel contextual abriu no restore, o pane passou de 96 para
    // 76 colunas e a fita da TUI voltou entrelaçada — moldura por cima do
    // texto, letras soltas empilhadas na borda.
    expect(canReplayScrollback(96, 76)).toBe(false);
  });

  it('recusa também quando a grade cresceu', () => {
    expect(canReplayScrollback(76, 96)).toBe(false);
  });

  it('permite fitas antigas sem largura gravada', () => {
    expect(canReplayScrollback(undefined, 80)).toBe(true);
  });
});
