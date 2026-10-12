import { expect, it, vi } from 'vitest';
import { classifyHeavyCommand } from './heavy-command-classifier';
it.each([
  ['npx tsc --noEmit', 'typescript'], ['node node_modules/typescript/bin/tsc --noEmit', 'typescript'],
  ['PATH=/custom/bin:$PATH npm run typecheck', 'typescript'], ['cd app && npm test', 'tests'],
  ['pnpm exec vitest run', 'tests'], ['npm run build', 'build'], ['cargo check', 'build'],
  ['go test ./...', 'tests'], ['npm ci', 'install'], ['make verify', 'build'],
  ['npm --workspace server test', 'tests'], ['npm --prefix app run build', 'build'],
  ['npx vite build', 'build'], ['npm.cmd run build', 'build'],
  ['pnpm --filter app exec vitest run', 'tests'], ['node /app/node_modules/jest/bin/jest.js', 'tests'],
])('classifies %s', (command, kind) => expect(classifyHeavyCommand(command)).toBe(kind));
it.each(['echo hello', 'git status', 'npm run dev', 'npm run start', 'cat typescript-notes.md', 'node server.js'])
  ('leaves %s outside the heavy queue', command => expect(classifyHeavyCommand(command)).toBeNull());
it('does bounded work and queues oversized scripts conservatively', () => {
  expect(classifyHeavyCommand(' '.repeat(1_000_000) + 'tsc')).toBe('build');
});

// F-1273: tool names inside quoted text, comments and heredoc bodies are not
// the program being run; the same cases are null in catalog.commandKind
// (heavy-command-catalog.test.ts, "ignores tool names that are not the
// program being run"). A false positive here holds the single heavy permit
// and the real heavy job dies with heavy_command_wait_timeout.
it.each([
  'git commit -m "fix: make tsc and vitest stop queueing; npm test passes"',
  'echo "run vite build later" # npm run build',
  `grep -n "'node'\\|npm\\|vitest" src/main/orch/heavy-command-classifier.ts | head -40`,
  "python3 - file.ts <<'EOF'\nmake install\nnpx vitest run\nEOF\necho done",
  'type git tr head node which sleep',
  'npm view @pierre/diffs version',
])('ignores tool names that are not the program: %s → null', (command) => {
  expect(classifyHeavyCommand(command)).toBeNull();
});

// F-1273 (revisão de ponta): o classificador antigo media esses runners; o
// catálogo devolvia null (pnpm/yarn/bun <bin>, python -m, poetry/uv/pipenv
// run) e 'build' para `node -e` trivial, que ocupava a única vaga do root.
it.each([
  ['pnpm vitest run', 'tests'], ['yarn jest', 'tests'], ['bun vitest', 'tests'],
  ['python -m pytest', 'tests'], ['poetry run pytest', 'tests'], ['uv run pytest', 'tests'],
])('meters runners started by a package manager or Python: %s → %s', (command, kind) => {
  expect(classifyHeavyCommand(command)).toBe(kind);
});
it.each(["node -e 'console.log(1)'", "node -p 'process.version'", "node --eval '1+1'"])
  ('inline node code is not a build: %s → null', (command) => expect(classifyHeavyCommand(command)).toBeNull());

// F-1273 (revisão de ponta): sem catalog.cjs o require lançava a cada chamada
// e tools-terminal/tools-bg relançavam: todo nexus_terminal_run quebrava.
it('degrades without throwing when the catalog cannot be loaded', async () => {
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:module')>();
    const createRequire = () => () => { throw new Error("Cannot find module 'catalog.cjs'"); };
    return { ...original, default: { ...original, createRequire }, createRequire };
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const degraded = (await import('./heavy-command-classifier')).classifyHeavyCommand;
    expect(() => degraded('git status')).not.toThrow();
    // Neither everything metered (a dev server would hold the root's only
    // slot) nor everything free (tsc/vitest/builds would run unbounded).
    expect(degraded('git status')).toBeNull();
    expect(degraded('npm run dev')).toBeNull();
    expect(degraded('git commit -m "fix: tsc and vitest"')).toBeNull();
    expect(degraded('cd app && npx vitest run')).toBe('build');
    expect(degraded('npm run build')).toBe('build');
    expect(degraded('tsc --noEmit')).toBe('build');
    expect(degraded('uv run pytest')).toBe('build');
    expect(degraded(' '.repeat(20_000) + 'echo')).toBe('build');
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
    vi.doUnmock('node:module');
    vi.resetModules();
  }
});
