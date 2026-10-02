import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUG_REPORT_CHANNELS } from './bug-report-channels';

describe('BUG_REPORT_CHANNELS', () => {
  it('uses its own namespace with distinct names', () => {
    const names = Object.values(BUG_REPORT_CHANNELS);
    expect(names.every((name) => name.startsWith('bugReport:'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with any other channel constant in the shared folder', () => {
    const sharedDir = path.dirname(new URL(import.meta.url).pathname);
    const own = new Set<string>(Object.values(BUG_REPORT_CHANNELS));
    for (const file of fs.readdirSync(sharedDir)) {
      if (!file.endsWith('.ts') || file.includes('.test.') || file === 'bug-report-channels.ts') continue;
      const source = fs.readFileSync(path.join(sharedDir, file), 'utf8');
      for (const name of own) expect(source, `${file} reuses ${name}`).not.toContain(`'${name}'`);
    }
  });

  it('keeps the module free of runtime dependencies so the sandboxed preload can import it', () => {
    const source = fs.readFileSync(new URL('./bug-report-channels.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
