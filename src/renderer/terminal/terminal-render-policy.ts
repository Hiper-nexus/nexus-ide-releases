import type { PaneModel } from '../../shared/types';

export interface TerminalOutputPolicyInput {
  readonly kind: PaneModel['kind'];
  readonly isFocused: boolean;
  readonly isPaneVisible: boolean;
  readonly isDocumentVisible: boolean;
  readonly performanceMode: 'adaptive' | 'quality';
}

export function terminalOutputPolicy(
  input: TerminalOutputPolicyInput,
): {
  foreground: boolean;
  latencySensitive: boolean;
  coalesceForeground: boolean;
  holdForeground: boolean;
  holdBackground: boolean;
} {
  const foreground =
    input.isFocused && input.isPaneVisible && input.isDocumentVisible;
  const shouldHoldHidden =
    input.performanceMode === 'adaptive' &&
    (!input.isPaneVisible || !input.isDocumentVisible);
  return {
    foreground,
    latencySensitive: foreground,
    coalesceForeground: foreground && input.kind === 'cli-agent',
    holdForeground: false,
    holdBackground: shouldHoldHidden,
  };
}

export function terminalScrollbackLines(
  kind: PaneModel['kind'],
  performanceMode: 'adaptive' | 'quality',
): number {
  if (performanceMode === 'quality') {
    return kind === 'cli-agent' ? 5_000 : 10_000;
  }
  return kind === 'cli-agent' ? 3_000 : 6_000;
}

/**
 * Por que um refit global está rodando. `display-scale` (zoom/monitor) muda
 * o desenho dos glifos SEM mudar cols/rows — repaint é obrigatório em todo
 * pane. `window-resize` é só backstop do ResizeObserver por host: pane cuja
 * grade não mudou produziria pixels idênticos — repaint é desperdício puro
 * (forma do bug herdado do Overclock: N panes parados = N repaints/ciclo).
 */
export type RefitReason = 'window-resize' | 'display-scale' | 'layout-change';

/**
 * Slot ainda 0×0: o xterm fica em 80×24 e a TUI desenha a moldura nessa
 * geometria. SIGWINCH depois não desfaz cursor absoluto — spawn só depois
 * da primeira medição real (F-009).
 */
export function hostSlotIsMeasurable(input: {
  readonly clientWidth: number;
  readonly clientHeight: number;
}): boolean {
  return input.clientWidth >= 16 && input.clientHeight >= 8;
}

export function shouldRepaintOnRefit(input: {
  readonly reason: RefitReason;
  readonly gridChanged: boolean;
}): boolean {
  if (input.reason === 'display-scale') return true;
  return input.gridChanged;
}

/** Dois gatilhos no mesmo debounce: o motivo mais caro governa a rodada. */
export function escalateRefitReason(
  pending: RefitReason | null,
  next: RefitReason,
): RefitReason {
  if (pending === 'display-scale' || next === 'display-scale') {
    return 'display-scale';
  }
  return next;
}

export function terminalGridChanged(
  previous: { readonly cols: number; readonly rows: number } | null,
  next: { readonly cols: number; readonly rows: number },
): boolean {
  return (
    previous === null ||
    previous.cols !== next.cols ||
    previous.rows !== next.rows
  );
}

/**
 * O scrollback salvo pode ser reescrito nesta grade?
 *
 * Uma TUI desenha moldura com cursor absoluto. A fita serializada carrega a
 * geometria da captura, então reescrevê-la numa largura diferente entrelaça
 * caixa e texto — e reflow não desfaz cursor absoluto. Esperar a largura
 * definitiva antes de escrever não resolve: o problema está nos bytes, não no
 * instante.
 *
 * Fitas antigas não têm largura gravada (`undefined`); replay é permitido para
 * não apagar histórico de quem atualizou no meio de uma sessão.
 */
export function canReplayScrollback(
  capturedCols: number | undefined,
  currentCols: number,
): boolean {
  if (capturedCols === undefined) return true;
  return capturedCols === currentCols;
}
