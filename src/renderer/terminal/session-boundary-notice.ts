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
 * Reset dos modos de INPUT do xterm na morte/troca de sessão. Uma TUI que
 * morre com mouse-tracking ligado deixa o xterm traduzindo cada movimento de
 * mouse em sequências SGR (`^[[<35;64;19M…`) que viram input do shell herdado
 * — o lixo na tela do operador em 20/08. Desliga mouse (todos os sabores),
 * encodings SGR/urxvt, focus reporting, bracketed paste, application cursor
 * keys e sai do alt-screen. Escrito COMO SAÍDA no xterm: é assim que o
 * emulador atualiza seus modos; o processo morto não recebe nada.
 */
export const TERMINAL_INPUT_MODE_RESET =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1006l\x1b[?1015l' +
  '\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?1049l';

/**
 * Escrito quando a largura atual diverge da largura em que o histórico foi
 * capturado. A3: a fita NÃO é descartada — cursor absoluto não reflui, então
 * ela espera pendente e reaparece quando o painel volta à largura gravada.
 * O aviso sai uma vez por episódio de divergência; sem ele o pane parecia
 * ter perdido a sessão.
 */
export const SCROLLBACK_WIDTH_MISMATCH_NOTICE =
  '\r\n\x1b[90m── histórico anterior guardado: reaparece quando o painel voltar à largura da captura ──\x1b[0m\r\n';

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

/**
 * A3: "o buffer só tem avisos" — boundary/hold/mismatch. Snapshot disso NÃO é
 * histórico: é o que sobrou enquanto a fita real esperava a largura (ou o
 * pane estava retido). Persistir/hibernar esse buffer apagava o scrollback
 * salvo do pane; quem decide o snapshot usa esta sonda para preferir a fita.
 *
 * Linhas classificadas como aviso: em branco, o prefixo `[nexus]`/`[Nexus]`,
 * divisórias `── … ──` e as continuações sem prefixo dos avisos de pausa.
 */
// As linhas de continuação (2ª linha sem prefixo [nexus]) de TODOS os avisos
// de pausa/aposentadoria de mission-owned-pane-policy.ts. Aviso novo com 2ª
// linha entra aqui — sem ela o buffer de um pane retido deixa de ser "só
// aviso" e o snapshot volta a sobrescrever a fita salva.
const NOTICE_CONTINUATION_LINES = new Set([
  'Clique a missão no rail e use Retomar.',
  'Confirme o diálogo ou retome a missão no rail quando quiser.',
  'Responda pela missão no rail para retomar.',
  'Inicie uma nova missão no rail.',
  'A conversa segue com o líder vivo no rail.',
  'O relatório final está na aba da missão no rail.',
]);

export function terminalBufferIsNoticeOnly(buffer: TerminalBufferProbe): boolean {
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    const text = line ? line.translateToString(true).trim() : '';
    if (text === '') continue;
    if (/^\[(?:nexus|Nexus)\]/.test(text)) continue;
    if (text.startsWith('──') && text.endsWith('──')) continue;
    if (NOTICE_CONTINUATION_LINES.has(text)) continue;
    // Continuação dinâmica dos avisos de conversa transferida ("no pane 7.
    // Este pane pode ser fechado." / "em «Maestro». Este pane pode ser
    // fechado.") — o destino varia, o sufixo não.
    if (text.endsWith('Este pane pode ser fechado.')) continue;
    return false;
  }
  return true;
}
