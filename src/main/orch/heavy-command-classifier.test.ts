import { expect, it } from 'vitest';
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
