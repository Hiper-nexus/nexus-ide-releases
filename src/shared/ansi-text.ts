// CSI sequences, OSC sequences, remaining lone escapes, then control bytes.
import { CSI_SEQUENCE_PATTERN } from './ansi-escape-sequences';

/* eslint-disable no-control-regex */
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_PATTERN, "")
    // F-1406: o CSI vem do padrão compartilhado — a classe [0-?]* cobre os
    // parâmetros privados (< = > ?) que o Codex 0.162 emite no boot
    // (ESC[>4;0m, ESC[>7u) e que a classe antiga [0-9;?] deixava como texto
    // visível na primeira linha do pane e no nexus_pane_read.
    .replace(CSI_SEQUENCE_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "");
}
