import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ICNS_PNG_ENTRIES,
  buildIcns,
  readIcnsEntries,
} from './build-macos-icon.mjs';
import { decodePng } from './build-windows-icon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('buildIcns', () => {
  it('writes every required modern macOS size as a PNG ICNS member', () => {
    const icns = buildIcns(readFileSync(resolve(ROOT, 'assets/icon.png')));
    const entries = readIcnsEntries(icns);

    expect(entries.map((entry) => entry.type)).toEqual(
      ICNS_PNG_ENTRIES.map((entry) => entry.type),
    );
    expect(entries.map((entry) => entry.size)).toEqual(
      ICNS_PNG_ENTRIES.map((entry) => entry.size),
    );
    expect(entries.map((entry) => entry.width)).toEqual(
      ICNS_PNG_ENTRIES.map((entry) => entry.size),
    );
    expect(entries.map((entry) => entry.height)).toEqual(
      ICNS_PNG_ENTRIES.map((entry) => entry.size),
    );
  });

  it('keeps every embedded PNG structurally decodable', () => {
    const icns = buildIcns(readFileSync(resolve(ROOT, 'assets/icon.png')));

    for (const entry of readIcnsEntries(icns)) {
      const png = icns.subarray(entry.offset, entry.offset + entry.bytes);
      const decoded = decodePng(png);
      expect(decoded.width).toBe(entry.size);
      expect(decoded.height).toBe(entry.size);
    }
  });
});
