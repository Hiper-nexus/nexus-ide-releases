import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexHookService } from './codex-hook-service';
import { codexHookTrustEntries } from './codex-hook-trust';
import { readHooksJson } from './installer-utils';

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

const MANAGED_EVENTS = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'stop',
];

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

  it('install seeds config.toml trust state for every managed event', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-codex-hooks-'));
    const svc = createCodexHookService({ home });
    svc.install();

    const tomlPath = join(home, '.codex', 'config.toml');
    expect(existsSync(tomlPath)).toBe(true);
    const toml = readFileSync(tomlPath, 'utf8');
    for (const event of MANAGED_EVENTS) {
      expect(toml).toContain(`hooks.state."`);
      expect(toml).toContain(`:${event}:`);
    }
    expect(toml.match(/^\[hooks\.state\./gm)).toHaveLength(6);

    // Every entry recomputed from the final hooks.json is present verbatim.
    const configPath = join(home, '.codex', 'hooks.json');
    const config = readHooksJson(configPath)!;
    const hooksJsonText = readFileSync(configPath, 'utf8');
    expect(hooksJsonText).toContain('codex-hook.sh');
    const scriptPath = join(home, '.nexus', 'agent-hooks', 'codex-hook.sh');
    const command = `if [ -x '${scriptPath}' ]; then /bin/sh '${scriptPath}'; fi`;
    for (const entry of codexHookTrustEntries(configPath, config, command)) {
      expect(toml).toContain(`[hooks.state."${entry.key}"]`);
      expect(toml).toContain(`trusted_hash = "${entry.trustedHash}"`);
    }
  });

  it('install preserves existing config.toml content and is idempotent', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-codex-hooks-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    const tomlPath = join(home, '.codex', 'config.toml');
    writeFileSync(tomlPath, '# user config\nmodel = "gpt-5"\n', 'utf8');

    const svc = createCodexHookService({ home });
    svc.install();
    const once = readFileSync(tomlPath, 'utf8');
    expect(once).toContain('# user config');
    expect(once).toContain('model = "gpt-5"');
    expect(once).toContain('[hooks.state."');

    svc.install();
    expect(readFileSync(tomlPath, 'utf8')).toBe(once);
  });

  it('remove strips only the managed trust sections', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-codex-hooks-'));
    const svc = createCodexHookService({ home });
    svc.install();

    const tomlPath = join(home, '.codex', 'config.toml');
    // A trust entry the user approved themselves must survive remove().
    const userSection =
      '[hooks.state."/other/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"\n';
    writeFileSync(
      tomlPath,
      `${readFileSync(tomlPath, 'utf8')}\n${userSection}`,
      'utf8',
    );

    expect(svc.remove().state).toBe('not_installed');
    const toml = readFileSync(tomlPath, 'utf8');
    expect(toml).not.toContain(join(home, '.codex', 'hooks.json'));
    expect(toml).toContain(userSection.trimEnd());
  });
});
