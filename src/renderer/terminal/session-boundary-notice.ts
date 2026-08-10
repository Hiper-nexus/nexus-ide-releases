/**
 * Session boundary marker (renderer side).
 *
 * When a NEW PTY session attaches to a pane that already has visible content
 * (restored persisted scrollback, respawn in the same xterm, fresh-context
 * recovery), the old output from the dead session used to blend into the live
 * one — stale bash banners sat right above the new agent and read as if they
 * belonged to it. The one-line divider makes the boundary explicit. It is
 * never printed on the first spawn of an empty pane.
 *
 * Follows the same idiom as the scheduler's BACKGROUND_BACKLOG_WARNING and
 * the preload PTY_GAP_NOTICE: styled one-liner written straight to xterm.
 * Pure helpers with no Electron imports so they stay unit-testable.
 */
export const SESSION_BOUNDARY_NOTICE =
  '\r\n\x1b[90m── sessão anterior encerrada · nova sessão iniciada ──\x1b[0m\r\n';

/**
 * Escrito quando o histórico salvo é descartado por ter sido capturado em
 * outra largura. Sem essa linha o pane volta vazio e o operador acha que
 * perdeu a sessão — quando a sessão está viva, só o histórico ficou de fora.
 */
export const SCROLLBACK_WIDTH_MISMATCH_NOTICE =
  '\r\n\x1b[90m── histórico anterior omitido: a largura do painel mudou · a sessão continua ativa ──\x1b[0m\r\n';

/** Minimal xterm buffer surface needed for the content probe. */
export interface TerminalBufferProbe {
  /** Lines that already scrolled into the scrollback region. */
  readonly baseY: number;
  /** Total buffered lines (scrollback + viewport). */
  readonly length: number;
  getLine(
    index: number,
  ): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * True when the terminal already shows anything. `baseY > 0` means scrollback
 * exists; otherwise only viewport rows can hold content, so the scan is
 * bounded by the terminal height.
 */
export function terminalBufferHasContent(buffer: TerminalBufferProbe): boolean {
  if (buffer.baseY > 0) return true;
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line && line.translateToString(true).trim().length > 0) return true;
  }
  return false;
}
