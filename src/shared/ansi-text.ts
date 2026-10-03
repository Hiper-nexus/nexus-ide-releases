// CSI sequences, OSC sequences, remaining lone escapes, then control bytes.
/* eslint-disable no-control-regex */
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "");
}

