import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexHookService } from './codex-hook-service';

let home: string;

afterEach(() => {
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('codex-hook-service', () => {
  it('installs managed script + hooks.json', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-codex-hooks-'));
    const svc = createCodexHookService({ home });
    svc.install();
    const status = svc.getStatus();
    expect(status.state).toBe('installed');
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
    const hooks = readFileSync(join(home, '.codex', 'hooks.json'), 'utf8');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain('Stop');
  });

  it('remove restores not_installed', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-codex-hooks-'));
    const svc = createCodexHookService({ home });
    svc.install();
    expect(svc.remove().state).toBe('not_installed');
  });
});
