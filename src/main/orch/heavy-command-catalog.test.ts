import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const catalog = require('../../../resources/heavy-command/catalog.cjs') as {
  commandKind(command: string): string | null;
};

// F-956: commands from a real orchestrator session that waited up to 300 s for
// the project's build slot and then died with exit 74, although none of them
// started a build. Each one names a tool without running it.
describe('commandKind ignores tool names that are not the program being run', () => {
  it.each([
    'type git tr head node which sleep',
    'which node',
    '/opt/homebrew/opt/node@22/bin/node -v',
    'node --version',
    'for c in git node npm pnpm; do echo "$c"; done',
    `grep -n "'node'\\|npm\\|vitest" src/main/orch/heavy-command-classifier.ts | head -40`,
    'ls -la node_modules | head -2',
    'git commit -m "fix: make tsc and vitest stop queueing; npm test passes"',
    "python3 - file.ts <<'EOF'\n# one project slot must not make them queue\nmake install\nnpx vitest run\nEOF\necho done",
    'echo "run vite build later" # npm run build',
    'npm view @pierre/diffs version',
  ])('%s → null', (command) => {
    expect(catalog.commandKind(command)).toBeNull();
  });
});

describe('commandKind still meters programs that do heavy work', () => {
  it.each([
    ['npx vitest run src/a.test.ts', 'tests'],
    ['export PATH=/opt/homebrew/opt/node@22/bin:$PATH; npx vitest run a.test.ts', 'tests'],
    ['cd mobile && npx tsc --noEmit', 'typescript'],
    ['npm run typecheck', 'typescript'],
    ['npm test', 'tests'],
    ['pnpm install', 'install'],
    ['NODE_OPTIONS=--dns-result-order=ipv4first npm install @pierre/diffs@1.5.2', 'install'],
    ['npm run build', 'build'],
    ['pnpm build', 'build'],
    ['for f in a b; do npx vitest run $f; done', 'tests'],
    ['timeout 600 npx vitest run', 'tests'],
    ['node scripts/release.mjs', 'build'],
    ['cat script.js | node', 'build'],
    ['vite build', 'build'],
    ['make -j8', 'build'],
    ['cargo test', 'tests'],
    ['npm install && npx vitest run', 'tests'],
    ['/bin/sh -c "make"', 'build'],
    ["bash -lc 'cd mobile && npx vitest run'", 'tests'],
  ])('%s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });

  it('keeps dev servers persistent and unmetered', () => {
    expect(catalog.commandKind('vite')).toBeNull();
    expect(catalog.commandKind('npx vite --port 5173')).toBeNull();
    expect(catalog.commandKind('node server.js')).toBeNull();
    expect(catalog.commandKind('"/opt/homebrew/bin/node" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 0')).toBeNull();
    expect(catalog.commandKind('node node_modules/vite/bin/vite.js build')).toBe('build');
    expect(catalog.commandKind('esbuild app.ts --watch')).toBeNull();
  });

  it('stays conservative for scripts too long to read', () => {
    expect(catalog.commandKind(`echo ${'x'.repeat(17_000)}`)).toBe('build');
  });
});
