import type { PaneModel } from '../../shared/types';

export interface TerminalOutputPolicyInput {
  readonly kind: PaneModel['kind'];
  readonly isFocused: boolean;
  readonly isPaneVisible: boolean;
  readonly isDocumentVisible: boolean;
  /** A revealed slot must finish fitting before old OR new PTY bytes paint. */
  readonly isGridReady?: boolean;
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
  const gridReady = input.isGridReady !== false;
  const foreground =
    gridReady && input.isFocused && input.isPaneVisible && input.isDocumentVisible;
  const shouldHoldHidden =
    !gridReady || (input.performanceMode === 'adaptive' &&
    (!input.isPaneVisible || !input.isDocumentVisible));
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
export type RefitReason =
  | 'window-resize'
  | 'display-scale'
  | 'layout-change'
  | 'workspace-reveal';

/**
 * Slot ainda 0×0: o xterm fica em 80×24 e a TUI desenha a moldura nessa
 * geometria. SIGWINCH depois não desfaz cursor absoluto — spawn só depois
 * da primeira medição real (F-009).
 */
export function hostSlotIsMeasurable(input: {
  readonly clientWidth: number;
  readonly clientHeight: number;
}): boolean {
  // 2×2 em janela ~1280 é ~500px. Splitter residual / 80×32 ainda pinta
  // TUI de 10 colunas que SIGWINCH não desfaz.
  return input.clientWidth >= 200 && input.clientHeight >= 80;
}

export function hostGridIsUsable(input: {
  readonly cols: number;
  readonly rows: number;
}): boolean {
  return input.cols >= 24 && input.rows >= 8;
}

/** Sessão já viva e a grade mudou no attach: bounce de SIGWINCH (paridade adoption). */
export function shouldBouncePtyGridAfterAttach(input: {
  readonly hasSession: boolean;
  readonly gridChanged: boolean;
}): boolean {
  return input.hasSession && input.gridChanged;
}

export function shouldRepaintOnRefit(input: {
  readonly reason: RefitReason;
  readonly gridChanged: boolean;
}): boolean {
  if (input.reason === 'display-scale' || input.reason === 'workspace-reveal') {
    return true;
  }
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
  if (pending === 'workspace-reveal' || next === 'workspace-reveal') {
    return 'workspace-reveal';
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

/**
 * Colunas mínimas para uma TUI não quebrar a própria linha de status.
 *
 * 80 cobre com folga a linha de status de agentes modernos com thinking longo,
 * ex.: `Harmonizing... still thinking with high effort (esc to interrupt · 12s)`
 * (70 caracteres) e TUIs padrão de 80 colunas.
 */
export const MIN_USABLE_COLS = 80;

/**
 * POR QUE ISTO EXISTE (medido ao vivo em 11/09, janela 1280, célula 7,74px):
 *
 * O CLI dentro do pane redesenha a linha de status no lugar com `\r`, assumindo
 * que ela CABE. Quando a linha é mais larga que `cols`, ela quebra; o `\r`
 * seguinte volta à coluna 0 da linha DE BAIXO, não da original. O cursor desce
 * um degrau por tick e cada quadro deixa resíduo — lixo permanente no
 * scrollback. Não é reflow nem renderer: é geométrico.
 *
 * Com muitos panes a grade encolhe até isso ser inevitável: 3 panes lado a lado
 * dão 28 colunas, 4 dão 21, 5 ou mais dão 8 (o piso de `MIN_PANE_WIDTH`).
 *
 * Este clamp sobe a GRADE de volta ao piso, sem mexer no pane: o TUI passa a
 * ver colunas suficientes (não quebra, não sobe lixo) e o excedente é cortado
 * pela borda do pane — corte é recuperável alargando o pane; o creep corrompe o
 * histórico de forma permanente.
 *
 * Só vale com SESSÃO VIVA: antes do spawn quem decide é `hostGridIsUsable` via
 * `settleHostGrid`, e subir a grade ali mudaria a decisão de adiar o spawn.
 */
export function clampGridToUsableCols(input: {
  readonly cols: number;
  readonly rows: number;
  readonly hasSession: boolean;
}): { cols: number; rows: number; clamped: boolean } {
  const untouched = { cols: input.cols, rows: input.rows, clamped: false };
  if (!input.hasSession) return untouched;
  if (!Number.isFinite(input.cols) || input.cols >= MIN_USABLE_COLS) {
    return untouched;
  }
  return { cols: MIN_USABLE_COLS, rows: input.rows, clamped: true };
}
