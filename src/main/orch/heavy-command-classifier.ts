import type { HeavyCommandKind } from './heavy-command-permit';
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell';
import { getCommandTokenPathBasename } from '../../shared/command-token-scanner';

const SCAN_CHARS = 16_384;
// This is resource scheduling, not a shell authorization parser. Unknown long
// scripts are conservatively queued; familiar interactive servers are not.
export function classifyHeavyCommand(command: string): HeavyCommandKind | null {
  if (command.length > SCAN_CHARS) return 'build';
  const text = command.slice(0, SCAN_CHARS);
  const parsed = tokenizeStartupCommand(text, process.platform === 'win32' ? 'cmd' : 'posix');
  const words = (parsed.ok ? parsed.tokens : text.split(/\s+/)).flatMap(token => token.split(/[;&|]/)).filter(Boolean);
  const program = (word: string) => getCommandTokenPathBasename(word).toLowerCase().replace(/\.(?:cmd|bat|exe|mjs|cjs|js)$/, '');
  const valueOptions = new Set(['--workspace', '--prefix', '--cwd', '--dir', '--filter', '--package', '--registry', '--cache', '--userconfig', '-w', '-c', '-p']);
  // Every token is visited once, including scripts with thousands of option
  // tokens or repeated runner names inside the fixed scan window.
  const argumentAt = new Int32Array(words.length + 2);
  argumentAt.fill(words.length);
  for (let i = words.length - 1; i >= 0; i--) {
    argumentAt[i] = words[i].startsWith('-')
      ? argumentAt[Math.min(words.length, i + (valueOptions.has(words[i].toLowerCase()) ? 2 : 1))]
      : i;
  }
  const nextArgument = (start: number) => argumentAt[Math.min(start, words.length)];
  const lastBuild = words.lastIndexOf('build');
  const actionKind = (action: string | undefined): HeavyCommandKind | null => {
    if (action && /^(?:typecheck|check-types)(?::|$)/i.test(action)) return 'typescript';
    if (action && /^(?:test|tests)(?::|$)/i.test(action)) return 'tests';
    if (action && /^(?:ci|install|add)(?::|$)/i.test(action)) return 'install';
    if (action && /^(?:build|check|verify|lint|publish)(?::|$)/i.test(action)) return 'build';
    return null;
  };
  for (let i = 0; i < words.length; i++) {
    const name = program(words[i]);
    if (name === 'tsc' || name === '_tsc') return 'typescript';
    if (['vitest', 'jest', 'pytest', 'mocha'].includes(name)) return 'tests';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
      const first = nextArgument(i + 1);
      const verb = words[first]?.toLowerCase();
      const kind = actionKind(verb === 'run' ? words[nextArgument(first + 1)] : verb);
      if (kind) return kind;
    }
    if (['vite', 'webpack', 'rollup', 'esbuild', 'next'].includes(name) && lastBuild > i) return 'build';
  }
  if (/(?:^|[\s/\\'";&|])(?:tsc(?:\.js|\.cjs)?|typecheck)(?=$|[\s'";&|:])/i.test(text)) return 'typescript';
  if (/(?:^|[\s/\\'";&|])(?:vitest|jest|pytest|mocha)(?=$|[\s'";&|])/i.test(text) ||
      /\b(?:npm|pnpm|yarn|bun|go|cargo|dotnet)\s+(?:run\s+)?(?:test|tests)(?=$|[\s'";&|:])/i.test(text)) return 'tests';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)(?=$|[\s'";&|])/i.test(text)) return 'install';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|verify|lint)(?=$|[\s'";&|:])/i.test(text) ||
      /\b(?:cargo|go|dotnet)\s+(?:build|check|install|publish)(?=$|[\s'";&|])/i.test(text) ||
      /(?:^|[\s/\\'";&|])(?:make|cmake|ninja|gradle|mvn)(?=$|[\s'";&|])/i.test(text)) return 'build';
  return null;
}
