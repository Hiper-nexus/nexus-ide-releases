import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CHOICE_CHANNELS } from './account-choice-channels';

describe('ACCOUNT_CHOICE_CHANNELS', () => {
  it('uses its own namespace with distinct names', () => {
    const names = Object.values(ACCOUNT_CHOICE_CHANNELS);
    expect(names.every((name) => name.startsWith('accountChoice:'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with any other channel constant in the shared folder', () => {
    // `URL.pathname` vira `/C:/…` no Windows; fileURLToPath dá o caminho nativo.
    const sharedDir = path.dirname(fileURLToPath(import.meta.url));
    const own = new Set<string>(Object.values(ACCOUNT_CHOICE_CHANNELS));
    for (const file of fs.readdirSync(sharedDir)) {
      if (!file.endsWith('.ts') || file.includes('.test.') || file === 'account-choice-channels.ts') continue;
      const source = fs.readFileSync(path.join(sharedDir, file), 'utf8');
      for (const name of own) expect(source, `${file} reuses ${name}`).not.toContain(`'${name}'`);
    }
  });

  it('keeps the module free of runtime dependencies so the sandboxed preload can import it', () => {
    const source = fs.readFileSync(new URL('./account-choice-channels.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
