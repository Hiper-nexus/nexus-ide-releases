import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeHookService } from './claude-hook-service';

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

describe('claude-hook-service', () => {
  it('installs managed script + settings and reports installed', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-claude-hooks-'));
    const svc = createClaudeHookService({ home });
    expect(svc.getStatus().state).toBe('not_installed');
    svc.install();
    const status = svc.getStatus();
    expect(status.state).toBe('installed');
    expect(status.managedHooksPresent).toBe(true);
    const scriptPath = join(
      home,
      '.nexus',
      'agent-hooks',
      process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh',
    );
    expect(existsSync(scriptPath)).toBe(true);
    const settings = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('UserPromptSubmit');
    expect(settings).toContain('agent-hooks/');
  });

  it('remove clears managed hooks', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-claude-hooks-'));
    const svc = createClaudeHookService({ home });
    svc.install();
    expect(svc.getStatus().state).toBe('installed');
    const after = svc.remove();
    expect(after.state).toBe('not_installed');
  });
});
