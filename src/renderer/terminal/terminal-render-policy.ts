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
