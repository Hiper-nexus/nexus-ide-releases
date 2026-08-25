import { describe, expect, it } from 'vitest';
import {
  canReplayScrollback,
  escalateRefitReason,
  hostGridIsUsable,
  hostSlotIsMeasurable,
  shouldBouncePtyGridAfterAttach,
  shouldRepaintOnRefit,
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

describe('shouldRepaintOnRefit', () => {
  // Forma do bug herdado do Overclock: refit global redesenhava TODO pane a
  // cada resize de janela, mesmo com a grade idêntica — N panes parados =
  // N repaints de pixels iguais por ciclo.
  it('resize de janela não repinta pane cuja grade não mudou', () => {
    expect(
      shouldRepaintOnRefit({ reason: 'window-resize', gridChanged: false }),
    ).toBe(false);
  });

  it('resize de janela repinta apenas quem mudou de grade', () => {
    expect(
      shouldRepaintOnRefit({ reason: 'window-resize', gridChanged: true }),
    ).toBe(true);
  });

  it('mudança de escala (DPR) repinta todos — glifos mudam sem mudar a grade', () => {
    expect(
      shouldRepaintOnRefit({ reason: 'display-scale', gridChanged: false }),
    ).toBe(true);
    expect(
      shouldRepaintOnRefit({ reason: 'display-scale', gridChanged: true }),
    ).toBe(true);
  });

  it('split/close de pane refita só quem mudou de grade (F-009)', () => {
    expect(
      shouldRepaintOnRefit({ reason: 'layout-change', gridChanged: false }),
    ).toBe(false);
    expect(
      shouldRepaintOnRefit({ reason: 'layout-change', gridChanged: true }),
    ).toBe(true);
  });
});

describe('hostSlotIsMeasurable (F-009)', () => {
  it('recusa o spawn enquanto o slot ainda não tem caixa', () => {
    expect(hostSlotIsMeasurable({ clientWidth: 0, clientHeight: 0 })).toBe(
      false,
    );
    expect(hostSlotIsMeasurable({ clientWidth: 80, clientHeight: 32 })).toBe(
      false,
    );
  });

  it('libera o spawn na primeira caixa real (split 2×2 incluso)', () => {
    expect(hostSlotIsMeasurable({ clientWidth: 200, clientHeight: 80 })).toBe(
      true,
    );
    expect(hostSlotIsMeasurable({ clientWidth: 500, clientHeight: 280 })).toBe(
      true,
    );
  });

  it('recusa grade TUI de 2 colunas mesmo com caixa pequena', () => {
    expect(hostGridIsUsable({ cols: 2, rows: 1 })).toBe(false);
    expect(hostGridIsUsable({ cols: 24, rows: 8 })).toBe(true);
  });
});

describe('shouldBouncePtyGridAfterAttach', () => {
  it('não bounce se ainda não há PTY', () => {
    expect(
      shouldBouncePtyGridAfterAttach({ hasSession: false, gridChanged: true }),
    ).toBe(false);
  });

  it('bounce quando a sessão headless pintou numa grade que o slot mudou', () => {
    expect(
      shouldBouncePtyGridAfterAttach({ hasSession: true, gridChanged: true }),
    ).toBe(true);
    expect(
      shouldBouncePtyGridAfterAttach({ hasSession: true, gridChanged: false }),
    ).toBe(false);
  });
});

describe('escalateRefitReason', () => {
  it('display-scale vence window-resize dentro do mesmo debounce', () => {
    expect(escalateRefitReason('window-resize', 'display-scale')).toBe(
      'display-scale',
    );
    expect(escalateRefitReason('display-scale', 'window-resize')).toBe(
      'display-scale',
    );
    expect(escalateRefitReason(null, 'window-resize')).toBe('window-resize');
  });
});
