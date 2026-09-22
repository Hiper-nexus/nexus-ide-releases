import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Um `var(--x)` sem definição e sem fallback invalida a declaração inteira: o
 * hover some, a cor de texto herda, a borda não aparece. Foi assim que os
 * hovers da barra lateral morreram (`--surface-hover` nunca existiu).
 */
const STYLES_DIR = path.dirname(new URL(import.meta.url).pathname);
const RENDERER_DIR = path.resolve(STYLES_DIR, '..');

/** Definidos em runtime (style inline no TSX ou ui-theme.ts), não em CSS. */
const RUNTIME_TOKENS = new Set([
  '--mission-graph-width',
  '--mission-graph-height',
  '--mission-agent-x',
  '--mission-agent-y',
]);

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

function definedTokens(): Set<string> {
  const defined = new Set(RUNTIME_TOKENS);
  for (const file of walk(RENDERER_DIR, /\.(css|tsx?)$/)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1]!);
    for (const match of source.matchAll(/['"](--[a-zA-Z0-9-]+)['"]/g)) defined.add(match[1]!);
  }
  return defined;
}

describe('CSS design tokens', () => {
  it('every var() without fallback points to a defined token', () => {
    const defined = definedTokens();
    const missing: string[] = [];
    for (const file of walk(STYLES_DIR, /\.css$/)) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
        if (!defined.has(match[1]!)) missing.push(`${path.basename(file)}: ${match[1]}`);
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
