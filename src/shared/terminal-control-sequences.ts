function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function skipStringControl(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return value.length;
}

/** Browser-safe removal of terminal controls before matching physical text. */
export function stripTerminalControlSequences(value: string): string {
  let text = '';
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(next)) {
        index = skipStringControl(value, index + 2);
        continue;
      }
      if (next === 0x5b) {
        index += 2;
        while (index < value.length && !isCsiFinal(value.charCodeAt(index))) {
          index += 1;
        }
        index += 1;
        continue;
      }
      index = Math.min(index + 2, value.length);
      continue;
    }
    if (code === 0x9b) {
      index += 1;
      while (index < value.length && !isCsiFinal(value.charCodeAt(index))) {
        index += 1;
      }
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      index += 1;
      continue;
    }
    text += value[index];
    index += 1;
  }
  return text;
}
