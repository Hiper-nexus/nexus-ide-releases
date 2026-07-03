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
  quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false },
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
});

// ── Builtin adapters ─────────────────────────────────────────────────────────

describe('builtin adapters', () => {
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
