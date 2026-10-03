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
