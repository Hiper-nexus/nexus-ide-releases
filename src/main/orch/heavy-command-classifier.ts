import type { HeavyCommandKind } from './heavy-command-permit';

const SCAN_CHARS = 16_384;
// This is resource scheduling, not a shell authorization parser. Unknown long
// scripts are conservatively queued; familiar interactive servers are not.
export function classifyHeavyCommand(command: string): HeavyCommandKind | null {
  if (command.length > SCAN_CHARS) return 'build';
  const text = command.slice(0, SCAN_CHARS);
  if (/(?:^|[\s/\\'";&|])(?:tsc(?:\.js|\.cjs)?|typecheck)(?=$|[\s'";&|:])/i.test(text)) return 'typescript';
  if (/(?:^|[\s/\\'";&|])(?:vitest|jest|pytest|mocha)(?=$|[\s'";&|])/i.test(text) ||
      /\b(?:npm|pnpm|yarn|bun|go|cargo|dotnet)\s+(?:run\s+)?(?:test|tests)(?=$|[\s'";&|:])/i.test(text)) return 'tests';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)(?=$|[\s'";&|])/i.test(text)) return 'install';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|verify|lint)(?=$|[\s'";&|:])/i.test(text) ||
      /\b(?:cargo|go|dotnet)\s+(?:build|check|install|publish)(?=$|[\s'";&|])/i.test(text) ||
      /(?:^|[\s/\\'";&|])(?:make|cmake|ninja|gradle|mvn)(?=$|[\s'";&|])/i.test(text)) return 'build';
  return null;
}
