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
