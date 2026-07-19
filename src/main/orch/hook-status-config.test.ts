import { describe, expect, it } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  GROK_STATUS_HOOKS_FILE,
  codexStatusHookArgs,
  grokStatusHooksDocument,
  mergeClaudeStatusHooks,
  mergeKimiStatusHooks,
} from './hook-status-config';

const MARKER = 'NEXUS_HOOK_STATUS';

/** The skill-gate entry shape hooks-gen.ts writes (must survive our merge). */
const SKILL_GATE_STOP = {
  hooks: [{ type: 'command', command: 'node "/home/x/.nexus/ephemeral/abc/nexus-gate.mjs" stop' }],
};
const USER_PROMPT_HOOK = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'echo user-prompt' }],
};

describe('mergeClaudeStatusHooks (Claude JSON settings)', () => {
  it('adds start/notification/stop status hooks preserving gate + user hooks', () => {
    const merged = mergeClaudeStatusHooks({
      Stop: [SKILL_GATE_STOP],
      UserPromptSubmit: [USER_PROMPT_HOOK],
    });

    expect(Object.keys(merged).sort()).toEqual([
      'Notification',
      'Stop',
      'UserPromptSubmit',
    ]);
    // Skill-gate Stop entry intact, ours appended alongside.
    expect(merged.Stop).toHaveLength(2);
    expect(merged.Stop![0]).toEqual(SKILL_GATE_STOP);
    // User hook intact, ours appended.
    expect(merged.UserPromptSubmit![0]).toEqual(USER_PROMPT_HOOK);
    expect(merged.UserPromptSubmit).toHaveLength(2);
    expect(merged.Notification).toHaveLength(1);

    const serialized = JSON.stringify(merged);
    expect(serialized).toContain(MARKER);
    expect(serialized).toContain('$NEXUS_HOOK_URL');
    expect(serialized).toContain('$NEXUS_GATE_TOKEN');
    expect(serialized).not.toMatch(/127\.0\.0\.1:\d/);
  });

  it('is idempotent — a second spawn rewrite does not duplicate entries', () => {
    const once = mergeClaudeStatusHooks({ Stop: [SKILL_GATE_STOP] });
    const twice = mergeClaudeStatusHooks(once);

    expect(twice).toEqual(once);
    expect(JSON.stringify(twice).match(new RegExp(MARKER, 'g'))).toHaveLength(3);
  });
});

describe('codexStatusHookArgs (Codex TOML -c overrides)', () => {
  function parseOverride(arg: string): Record<string, unknown> {
    // Re-parse exactly what Codex would: a dotted key + TOML value.
    return parseToml(arg) as Record<string, unknown>;
  }

  it('emits -c overrides for SessionStart/UserPromptSubmit/Stop/PermissionRequest', () => {
    const args = codexStatusHookArgs();
    const keys: string[] = [];
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-c');
      keys.push(args[i + 1]!.split('=')[0]!);
    }
    expect(keys).toEqual([
      'hooks.SessionStart',
      'hooks.UserPromptSubmit',
      'hooks.Stop',
      'hooks.PermissionRequest',
    ]);
  });

  it('every override value is valid TOML carrying a marked, env-only command', () => {
    const args = codexStatusHookArgs();
    for (let i = 1; i < args.length; i += 2) {
      const parsed = parseOverride(args[i]!) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
      };
      const [, entries] = Object.entries(parsed.hooks)[0]!;
      expect(entries).toHaveLength(1);
      const [hook] = entries[0]!.hooks;
      expect(hook!.type).toBe('command');
      expect(hook!.command).toContain(MARKER);
      expect(hook!.command).toContain('$NEXUS_GATE_TOKEN');
      expect(hook!.command).toContain('$NEXUS_HOOK_URL');
      expect(hook!.command).toContain('|| true');
      expect(hook!.command).toContain('X-Nexus-Hook-Flavor: codex');
    }
  });

  it('is deterministic — a second spawn produces identical argv (no accumulation)', () => {
    expect(codexStatusHookArgs()).toEqual(codexStatusHookArgs());
  });
});

describe('mergeKimiStatusHooks (Kimi TOML flat array)', () => {
  it('merges marked entries into config.toml content, preserving user hooks', () => {
    const userEntry = { event: 'Stop', command: 'echo user-stop' };
    const merged = mergeKimiStatusHooks({ model: 'k2', hooks: [userEntry] });

    const hooks = merged.hooks as Array<{ event: string; command: string }>;
    expect(hooks[0]).toEqual(userEntry);
    expect(hooks.length).toBeGreaterThan(1);
    expect(merged.model).toBe('k2');
    // Round-trip through real TOML, the way the overlay writer persists it.
    const reparsed = parseToml(stringifyToml(merged)) as typeof merged;
    expect(JSON.stringify(reparsed)).toContain(MARKER);
  });

  it('second spawn rewrite does not duplicate Nexus entries', () => {
    const once = mergeKimiStatusHooks({});
    const twice = mergeKimiStatusHooks(once);
    expect(twice).toEqual(once);
  });
});

describe('grokStatusHooksDocument (Grok hooks/nexus.json)', () => {
  it('builds the nested hooks document with marked commands', () => {
    const doc = grokStatusHooksDocument();
    const hooks = doc.hooks as Record<string, unknown[]>;

    expect(Object.keys(hooks)).toContain('SessionStart');
    expect(Object.keys(hooks)).toContain('Stop');
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain(MARKER);
    expect(serialized).toContain('X-Nexus-Hook-Flavor: grok');
    expect(GROK_STATUS_HOOKS_FILE).toBe('nexus.json');
  });
});
