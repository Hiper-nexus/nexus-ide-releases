import { createRequire } from 'node:module';
import path from 'node:path';
import type { HeavyCommandKind } from './heavy-command-permit';

// F-1273: the permit decision on the Main side must agree with the one the
// resource hooks make, so it reuses catalog.commandKind verbatim: quoted
// text, comments and heredoc bodies are never the program being run, and a
// command longer than 16384 chars stays conservatively metered as 'build'.
const requireForCatalog = createRequire(__filename);
type CatalogCommandKind = (command: string) => string | null;
// undefined: not loaded yet; null: unavailable, the degraded fallback answers.
let catalogKind: CatalogCommandKind | null | undefined;
function loadCatalogKind(): CatalogCommandKind | null {
  if (catalogKind !== undefined) return catalogKind;
  try {
    // In the app the catalog ships next to the other heavy-command resources;
    // this mirrors native-heavy-preload.ts's path selection.
    const electron = require('electron') as typeof import('electron');
    const file = electron.app.isPackaged
      ? path.join(process.resourcesPath, 'heavy-command', 'catalog.cjs')
      : path.join(electron.app.getAppPath(), 'resources', 'heavy-command', 'catalog.cjs');
    catalogKind = (requireForCatalog(file) as { commandKind: CatalogCommandKind }).commandKind;
    if (typeof catalogKind === 'function') return catalogKind;
  } catch {}
  try {
    // Outside the running app (unit tests, tooling): resolve from this source.
    catalogKind = (requireForCatalog('../../../resources/heavy-command/catalog.cjs') as { commandKind: CatalogCommandKind }).commandKind;
    if (typeof catalogKind !== 'function') throw new Error('catalog.cjs has no commandKind');
  } catch (error) {
    // F-1273 (revisão): throwing here made tools-terminal/tools-bg rethrow, so
    // every nexus_terminal_run failed. Warn once and stay degraded.
    catalogKind = null;
    console.warn(`[heavy-command] catalog.cjs unavailable; heavy admission runs degraded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return catalogKind;
}

// Degraded mode only (catalog.cjs missing or broken in the build). Metering
// everything would park `git status` and dev servers (`npm run dev`, held for
// their whole life) on the root's single heavy slot; metering nothing would let
// tsc/vitest/builds run unbounded. So, per simple command, only the word in
// program position counts: a known finite heavy tool, directly or behind a
// package manager/runner (`npx vitest`, `npm run build`, `uv run pytest`), is
// 'build'; oversized scripts stay 'build' as in the catalog.
const FALLBACK_TOOLS = new Set(['tsc', 'tsgo', 'vitest', 'jest', 'mocha', 'pytest', 'make', 'cmake', 'ninja', 'gradle', 'gradlew', 'mvn', 'webpack', 'rollup']);
const FALLBACK_VERBS = new Set(['test', 'tests', 't', 'install', 'i', 'ci', 'add', 'build', 'typecheck', 'check', 'verify']);
const FALLBACK_LAUNCHER = /^(?:npm|pnpm|yarn|bun|npx|pnpx|bunx|exec|dlx|run|x|uv|uvx|poetry|pipenv|python[\d.]*|cargo|go|dotnet)$/;
function fallbackKind(command: string): HeavyCommandKind | null {
  if (command.length > 16_384) return 'build';
  for (const segment of command.split(/[;&|\n(){}`]+/)) {
    let launched = false;
    for (const word of segment.trim().split(/\s+/)) {
      if (!word || word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      const name = path.basename(word).toLowerCase().replace(/\.(?:cmd|bat|exe|[cm]?js)$/, '');
      if (FALLBACK_TOOLS.has(name) || (launched && FALLBACK_VERBS.has(name))) return 'build';
      if (!FALLBACK_LAUNCHER.test(name)) break;
      launched = true;
    }
  }
  return null;
}

export function classifyHeavyCommand(command: string): HeavyCommandKind | null {
  const kind = loadCatalogKind();
  return kind ? kind(command) as HeavyCommandKind | null : fallbackKind(command);
}
