import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural gate: Wave modules must not re-introduce
 * `startsWith(path.resolve(...))` containment (sibling-prefix trap).
 *
 * Allowlist: only this file's documentation comments and known-safe patterns
 * outside product-wave IPC. Fail the suite if new hits appear under src/main.
 */

const ROOT = path.resolve(__dirname, '../..');
const MAIN = path.join(ROOT, 'main');

const FORBIDDEN = [
  /startsWith\s*\(\s*path\.resolve/,
  /\.startsWith\s*\(\s*path\.resolve/,
];

/** Relative paths under src/main that may keep legacy patterns (none preferred). */
const ALLOWLIST = new Set<string>([
  // Gate file itself may mention the pattern in comments — we skip test files.
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('structural gate: no startsWith(path.resolve) containment', () => {
  it('finds zero forbidden containment patterns in src/main product code', () => {
    const files = walk(MAIN);
    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(MAIN, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // Strip block comments and line comments roughly for false positives
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const re of FORBIDDEN) {
        if (re.test(code)) {
          hits.push(`${rel}: ${re}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
