import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  cliPtyAdapterSchema,
  adapterSchema,
  resolvePlaceholders,
} from '../../shared/adapter-types';
import type { Adapter } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { mergeAdapters, broadcastToListeners } from './adapter-registry';

// ── Minimal valid cli-pty adapter for reuse across tests ────────────────────

const MINIMAL_CLI_PTY = {
  kind: 'cli-pty' as const,
  id: 'test-cli',
  label: 'Test CLI',
  version: '1.0.0',
  icon: '🤖',
  bin: 'test-cli',
  detect: 'test-cli --version',
  install: { method: 'npm' as const, command: 'npm install -g test-cli' },
  auth: { method: 'none' as const },
  spawn: {
    interactive: ['test-cli'],
    headless: ['test-cli', '--prompt', '{{PROMPT}}'],
    ptyRequired: true,
    resumeArgs: [],
    extraArgs: [],
  },
  env: { static: {}, passthrough: [], ephemeralHome: false },
  models: { flag: '--model', list: ['default'], default: 'default' },
  promptInjection: { method: 'arg' as const, trailingNewline: true, bracketedPaste: false },
  stateParsing: {
    idle: { type: 'timeout' as const, ms: 500 },
    shellIntegration: false,
    exitCodes: {},
  },
  quirks: {
    altScreen: false,
    requiresNoAutoUpdate: false,
    mcpAutoload: false,
    nexusMcp: 'none' as const,
  },
  control: {},
};

// ── Schema validation tests ──────────────────────────────────────────────────

describe('cliPtyAdapterSchema', () => {
  it('accepts a fully valid cli-pty adapter', () => {
    const result = cliPtyAdapterSchema.safeParse(MINIMAL_CLI_PTY);
    expect(result.success).toBe(true);
  });

  it('rejects an adapter missing required fields', () => {
    const result = cliPtyAdapterSchema.safeParse({ kind: 'cli-pty', id: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects an id with illegal characters', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      id: 'My CLI!',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an id with uppercase', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      id: 'MyCLI',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a timeout idle pattern', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'timeout', ms: 1000 } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a regex idle pattern', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'regex', pattern: '^\\$ ' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown idle pattern type', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      stateParsing: { ...MINIMAL_CLI_PTY.stateParsing, idle: { type: 'magic' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts uv as an isolated Python tool installer', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      install: {
        method: 'uv',
        command: 'uv tool install aider-chat',
      },
    });
    expect(result.success).toBe(true);
  });

  it('keeps legacy custom adapters with only mcpAutoload enabled', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      quirks: {
        altScreen: false,
        requiresNoAutoUpdate: false,
        mcpAutoload: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quirks.mcpAutoload).toBe(true);
      expect(result.data.quirks.nexusMcp).toBe('none');
    }
  });

  it('rejects nexusMcp autoload when the injection path is disabled', () => {
    const result = cliPtyAdapterSchema.safeParse({
      ...MINIMAL_CLI_PTY,
      quirks: {
        ...MINIMAL_CLI_PTY.quirks,
        mcpAutoload: false,
        nexusMcp: 'autoload',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['quirks', 'nexusMcp'],
          }),
        ]),
      );
    }
  });
});

// ── Builtin adapters ─────────────────────────────────────────────────────────

describe('builtin adapters', () => {
  const builtin = (id: string) =>
    BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === id,
    ) as {
      install?: { method?: string; command?: string };
      spawn?: {
        headless?: string[];
        resumeArgs?: string[];
        resumeIdArgs?: string[];
      };
      control?: { permission?: { safe?: string[] } };
    } | undefined;

  it('all builtins pass schema validation', () => {
    for (const raw of BUILTIN_ADAPTERS) {
      const result = adapterSchema.safeParse(raw);
      if (!result.success) {
        const raw_ = raw as { id?: unknown };
        throw new Error(
          `Builtin adapter "${raw_?.id ?? '?'}" failed validation: ` +
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      expect(result.success).toBe(true);
    }
  });

  it('all builtin ids are unique', () => {
    const ids = BUILTIN_ADAPTERS.map((a) => (a as { id?: string }).id ?? '');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all builtins are cli-pty kind', () => {
    for (const raw of BUILTIN_ADAPTERS) {
      expect((raw as { kind?: string }).kind).toBe('cli-pty');
    }
  });

  it('declares Nexus MCP capability once, leaving only Aider worker-only', () => {
    const integration = (id: string) =>
      (BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      ) as { quirks?: { nexusMcp?: string } } | undefined)?.quirks?.nexusMcp;

    expect(integration('aider')).toBe('none');
    expect(integration('claude')).toBe('autoload');
    expect(integration('glm')).toBe('autoload');
    expect(integration('longcat')).toBe('autoload');
    expect(integration('codex')).toBe('codex');
    expect(integration('agy')).toBe('agy');
    expect(integration('opencode')).toBe('opencode');
    expect(integration('kimi')).toBe('kimi');
    expect(integration('grok')).toBe('grok');
  });

  it('claude builtin has altScreen:true', () => {
    const claude = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'claude',
    ) as { quirks?: { altScreen?: boolean } } | undefined;
    expect(claude?.quirks?.altScreen).toBe(true);
  });

  it('aider builtin has altScreen:false', () => {
    const aider = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'aider',
    ) as { quirks?: { altScreen?: boolean } } | undefined;
    expect(aider?.quirks?.altScreen).toBe(false);
  });

  it('agy yolo flag matches the installed Antigravity CLI', () => {
    const agy = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'agy',
    ) as { control?: { permission?: { yolo?: string[] } } } | undefined;
    expect(agy?.control?.permission?.yolo).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('pins safe sandbox/approval flags for the primary coding CLIs', () => {
    const permission = (id: string) =>
      (BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: string }).id === id,
      ) as { control?: { permission?: { safe?: string[] } } } | undefined)
        ?.control?.permission;
    expect(permission('codex')?.safe).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]);
    expect(permission('claude')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('agy')?.safe).toEqual(['--sandbox']);
    expect(permission('glm')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('longcat')?.safe).toEqual([
      '--permission-mode',
      'manual',
    ]);
    expect(permission('grok')?.safe).toEqual([
      '--permission-mode',
      'default',
      '--sandbox',
      'workspace',
    ]);
  });

  it('uses current official and reversible package-manager installs where available', () => {
    expect(builtin('aider')?.install).toEqual({
      method: 'uv',
      command:
        'uv tool install --force --python python3.12 --with pip aider-chat@latest',
    });
    expect(builtin('opencode')?.install).toEqual({
      method: 'brew',
      command: 'brew install anomalyco/tap/opencode',
    });
    expect(builtin('kimi')?.install).toEqual({
      method: 'npm',
      command: 'npm install -g @moonshot-ai/kimi-code',
    });
  });

  it('uses Kimi Code transient-model env instead of ignored legacy key vars', () => {
    const kimi = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'kimi',
    ) as {
      auth?: { method?: string; envVarFallback?: string };
      env?: { passthrough?: string[] };
    } | undefined;

    expect(kimi?.auth).toMatchObject({
      method: 'api_key',
      envVarFallback: 'KIMI_MODEL_API_KEY',
    });
    expect(kimi?.env?.passthrough).toContain('KIMI_MODEL_NAME');
    expect(kimi?.env?.passthrough).toContain('KIMI_MODEL_API_KEY');
    expect(kimi?.env?.passthrough).not.toContain('MOONSHOT_API_KEY');
    expect(kimi?.env?.passthrough).not.toContain('KIMI_API_KEY');
  });

  it('declares only provider-qualified OpenCode models with a locally available default', () => {
    const opencode = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'opencode',
    ) as { models?: { list?: string[]; default?: string } } | undefined;

    expect(opencode?.models?.default).toBe('opencode/big-pickle');
    expect(opencode?.models?.list).toContain('opencode/big-pickle');
    expect(opencode?.models?.list?.every((model) => model.includes('/')))
      .toBe(true);
  });

  it('uses the xAI CLI official API-key variable for Grok', () => {
    const grok = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: string }).id === 'grok',
    ) as {
      auth?: { envVarFallback?: string };
      env?: { passthrough?: string[] };
    } | undefined;

    expect(grok?.auth?.envVarFallback).toBe('XAI_API_KEY');
    expect(grok?.env?.passthrough).toEqual(['XAI_API_KEY']);
  });

  it('never substitutes community packages for the installed official AGY/Grok CLIs', () => {
    expect(builtin('agy')?.install).toEqual({
      method: 'manual',
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    });
    expect(builtin('grok')?.install).toEqual({
      method: 'manual',
      command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    });
  });

  it('uses the current Codex exec subcommand for non-interactive work', () => {
    expect(builtin('codex')?.spawn?.headless).toEqual([
      'codex',
      '--ask-for-approval',
      'on-request',
      'exec',
      '--sandbox',
      'workspace-write',
      '{{PROMPT}}',
    ]);
  });

  it('does not silently auto-approve headless Grok work', () => {
    expect(builtin('grok')?.spawn?.headless).toEqual([
      'grok',
      '-p',
      '{{PROMPT}}',
    ]);
  });

  it.each([
    ['agy', ['--continue'], ['--conversation']],
    ['claude', ['--continue'], ['--resume']],
    ['codex', ['resume', '--last'], ['resume']],
    ['glm', ['--continue'], ['--resume']],
    ['grok', ['--continue'], ['--resume']],
    ['kimi', ['--continue'], ['--session']],
    ['longcat', ['--continue'], ['--resume']],
    ['opencode', ['--continue'], ['--session']],
  ])(
    '%s resumes the latest or an exact provider session with current flags',
    (id, latest, exact) => {
      expect(builtin(id)?.spawn?.resumeArgs).toEqual(latest);
      expect(builtin(id)?.spawn?.resumeIdArgs).toEqual(exact);
    },
  );

  it('grok trusts the workspace folder before the TUI prompt can block', () => {
    const grok = BUILTIN_ADAPTERS.find(
      (a) => (a as { id?: string }).id === 'grok',
    ) as { spawn?: { extraArgs?: string[] } } | undefined;
    expect(grok?.spawn?.extraArgs).toContain('--trust-folder');
  });
});

// ── resolvePlaceholders ──────────────────────────────────────────────────────

describe('resolvePlaceholders', () => {
  it('replaces known placeholders', () => {
    const args = ['--model', '{{MODEL}}', '-p', '{{PROMPT}}'];
    const vars = { MODEL: 'claude-opus', PROMPT: 'hello world' };
    expect(resolvePlaceholders(args, vars)).toEqual([
      '--model', 'claude-opus', '-p', 'hello world',
    ]);
  });

  it('resolves unknown placeholders to empty string', () => {
    const args = ['{{UNKNOWN}}'];
    expect(resolvePlaceholders(args, {})).toEqual(['']);
  });

  it('leaves args with no placeholders unchanged', () => {
    const args = ['claude', '--no-auto-update', '--model', 'default'];
    expect(resolvePlaceholders(args, {})).toEqual(args);
  });

  it('handles multiple placeholders in one arg', () => {
    const args = ['{{BIN}}-{{VERSION}}'];
    expect(resolvePlaceholders(args, { BIN: 'mycli', VERSION: '1.0' })).toEqual([
      'mycli-1.0',
    ]);
  });

  it('handles empty args array', () => {
    expect(resolvePlaceholders([], { MODEL: 'x' })).toEqual([]);
  });
});

// ── broadcastToListeners (destroyed-window guard) ────────────────────────────

describe('broadcastToListeners', () => {
  const fakeWc = (destroyed: boolean, crashed = false) =>
    ({
      isDestroyed: () => destroyed,
      isCrashed: () => crashed,
      send: vi.fn(),
    }) as unknown as WebContents;

  it('sends to a live listener', () => {
    const wc = fakeWc(false);
    const targets = new Set<WebContents>([wc]);
    broadcastToListeners(targets, 'ch', { a: 1 });
    expect(wc.send).toHaveBeenCalledWith('ch', { a: 1 });
  });

  it('does not send to a destroyed listener (no throw)', () => {
    const wc = fakeWc(true);
    const targets = new Set<WebContents>([wc]);
    expect(() => broadcastToListeners(targets, 'ch', {})).not.toThrow();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('skips a crashed listener but keeps it (renderer may reload)', () => {
    const wc = fakeWc(false, true);
    const targets = new Set<WebContents>([wc]);
    expect(() => broadcastToListeners(targets, 'ch', {})).not.toThrow();
    expect(wc.send).not.toHaveBeenCalled();
    expect(targets.has(wc)).toBe(true);
  });

  it('prunes destroyed listeners from the set', () => {
    const dead = fakeWc(true);
    const live = fakeWc(false);
    const targets = new Set<WebContents>([dead, live]);
    broadcastToListeners(targets, 'ch', {});
    expect(targets.has(dead)).toBe(false);
    expect(targets.has(live)).toBe(true);
  });

  it('delivers to live listeners even when a destroyed one is present', () => {
    const dead = fakeWc(true);
    const live = fakeWc(false);
    const targets = new Set<WebContents>([dead, live]);
    broadcastToListeners(targets, 'ch', { ok: true });
    expect(live.send).toHaveBeenCalledWith('ch', { ok: true });
  });
});

// ── mergeAdapters ────────────────────────────────────────────────────────────

describe('mergeAdapters', () => {
  const buildAdapter = (id: string, label: string): Adapter =>
    ({ ...MINIMAL_CLI_PTY, id, label }) as Adapter;

  it('user adapter with same id overrides builtin', () => {
    const builtin = buildAdapter('claude', 'Claude (builtin)');
    const user = buildAdapter('claude', 'Claude (custom)');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.get('claude')?.label).toBe('Claude (custom)');
  });

  it('user adapter with new id is added alongside builtins', () => {
    const builtin = buildAdapter('claude', 'Claude');
    const user = buildAdapter('my-cli', 'My CLI');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.size).toBe(2);
    expect(merged.has('my-cli')).toBe(true);
  });

  it('empty user list returns only builtins', () => {
    const builtins = [buildAdapter('a', 'A'), buildAdapter('b', 'B')];
    const merged = mergeAdapters(builtins, []);
    expect(merged.size).toBe(2);
  });

  it('builtin-only ids are preserved when user has no conflicts', () => {
    const builtin = buildAdapter('codex', 'Codex');
    const user = buildAdapter('my-cli', 'My CLI');
    const merged = mergeAdapters([builtin], [user]);
    expect(merged.has('codex')).toBe(true);
  });
});
