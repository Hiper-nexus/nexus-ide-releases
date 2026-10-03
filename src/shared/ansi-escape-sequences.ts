/* eslint-disable no-control-regex -- these patterns exist to match terminal control bytes. */

/**
 * OSC title/progress frames, 7-bit (ESC ]) and 8-bit (U+009D) introducers.
 *
 * Referência SEMÂNTICA (F-764 C.3): com muitos introdutores sem terminador o
 * `[\s\S]*?` recomeça do zero em cada um e varre até o fim — quadrático (16 KB
 * de `ESC ]` custavam ~70 ms). Texto de PTY passa por
 * `stripAnsiEscapeSequences`, que remove exatamente o mesmo em tempo linear.
 */
export const OSC_SEQUENCE_PATTERN = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g
/** DCS/APC/PM/SOS string sequences terminated by ST (mesma ressalva do OSC). */
export const STRING_SEQUENCE_PATTERN =
  /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g
/** CSI sequences (colors, cursor moves, `\u001b[0K` erase-to-EOL). */
export const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
/** Remaining two/three-byte escape sequences (charset selection, RIS, ...). */
export const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g
/** C0/C1 control bytes except tab, line feed and carriage return. */
export const TERMINAL_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

const OSC_INTRODUCER = /\u001b\]|\u009d/g
const OSC_TERMINATOR = /\u0007|\u001b\\|\u009c/g
const STRING_INTRODUCER = /\u001b[P_^X]|[\u0090\u0098\u009e\u009f]/g
const STRING_TERMINATOR = /\u001b\\|\u009c/g

/**
 * Remove toda sequência `introdutor … primeiro terminador` em UMA passada —
 * o mesmo resultado de `value.replace(/I[\s\S]*?T/g, '')`, em tempo linear.
 *
 * Por que é equivalente: o casamento preguiçoso a partir de um introdutor vai
 * até o PRIMEIRO terminador depois dele; e se não existe terminador depois de
 * um introdutor, não existe depois de nenhum introdutor seguinte — então a
 * varredura pode parar ali, em vez de recomeçar em cada introdutor (que é o
 * que deixava a regex quadrática). Os regex precisam da flag `g`: o
 * `lastIndex` é a posição de busca.
 */
export function removeTerminatedSequences(
  value: string,
  introducer: RegExp,
  terminator: RegExp,
): string {
  introducer.lastIndex = 0
  let start = introducer.exec(value)
  if (!start) return value
  let out = ''
  let cursor = 0
  while (start) {
    terminator.lastIndex = start.index + start[0].length
    const end = terminator.exec(value)
    if (!end) break
    out += value.slice(cursor, start.index)
    cursor = end.index + end[0].length
    introducer.lastIndex = cursor
    start = introducer.exec(value)
  }
  return cursor === 0 ? value : out + value.slice(cursor)
}

/**
 * Remove ANSI escape sequences while preserving text, tabs and line breaks.
 * Ordering matters: OSC/string sequences must be consumed before the generic
 * escape pattern, which would otherwise eat only their introducer.
 */
export function stripAnsiEscapeSequences(value: string): string {
  const withoutOsc = removeTerminatedSequences(value, OSC_INTRODUCER, OSC_TERMINATOR)
  return removeTerminatedSequences(withoutOsc, STRING_INTRODUCER, STRING_TERMINATOR)
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
}
