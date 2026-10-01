import { describe, expect, it } from 'vitest';
import {
  availablePermissionModes,
  buildControlArgs,
  defaultPermissionMode,
  supportsVerbose,
} from './control-args';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { adapterSchema } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';

function adapter(control: CliPtyAdapter['control']): CliPtyAdapter {
  return {
    kind: 'cli-pty',
    id: 'x',
    label: 'X',
    version: '1',
    icon: '🤖',
    bin: 'x',
    detect: 'x --version',
    install: { method: 'npm', command: 'npm i -g x' },
    auth: { method: 'api_key' },
    spawn: { interactive: ['x'], headless: [], ptyRequired: true, resumeArgs: [], extraArgs: [] },
    env: { static: {}, passthrough: [], ephemeralHome: false },
    models: { flag: '--model', list: ['m'], default: 'm' },
    promptInjection: { method: 'arg', trailingNewline: true, bracketedPaste: false },
    stateParsing: { idle: { type: 'timeout', ms: 800 }, shellIntegration: false, exitCodes: {} },
    quirks: {
      altScreen: false,
      requiresNoAutoUpdate: false,
      mcpAutoload: false,
      nexusMcp: 'none',
    },
    control,
  } as CliPtyAdapter;
}

const CLAUDE_LIKE = adapter({
  permission: {
    arg: '--permission-mode',
    modes: { bypass: 'bypassPermissions', auto: 'acceptEdits', plan: 'plan', default: 'default' },
    yolo: ['--dangerously-skip-permissions'],
    safe: ['--permission-mode', 'manual'],
    default: '',
  },
  effort: { arg: '--effort', levels: ['low', 'medium', 'high', 'xhigh'] },
  verbose: '--verbose',
});

describe('buildControlArgs', () => {
  it('maps a permission mode to arg + value', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: 'auto' })).toEqual([
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('uses standalone yolo args for full-auto', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: 'yolo' })).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('maps bypass to the same zero-click yolo argv (system default path)', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: 'bypass' })).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('treats empty permission mode as product full-auto default, not manual', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: '' })).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(buildControlArgs(CLAUDE_LIKE, {})).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('adds effort and verbose flags when chosen', () => {
    expect(
      buildControlArgs(CLAUDE_LIKE, { effort: 'high', verbose: true }),
    ).toEqual([
      '--dangerously-skip-permissions',
      '--effort',
      'high',
      '--verbose',
    ]);
  });

  it('still honors explicit plan mode (restricted, not full-auto)', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: 'plan' })).toEqual([
      '--permission-mode',
      'plan',
    ]);
  });

  it('builds Codex config effort as a non-empty -c assignment', () => {
    const codexLike = adapter({
      effort: {
        arg: '-c model_reasoning_effort=',
        levels: ['low', 'medium', 'high', 'xhigh'],
      },
    });
    expect(buildControlArgs(codexLike, { effort: 'high' })).toEqual([
      '-c',
      'model_reasoning_effort=high',
    ]);
  });

  it('forces medium for assignment-style effort when blank (Codex boot-safe)', () => {
    const codexLike = adapter({
      effort: {
        arg: '-c model_reasoning_effort=',
        levels: ['low', 'medium', 'high', 'xhigh'],
      },
    });
    expect(buildControlArgs(codexLike, { effort: '' })).toEqual([
      '-c',
      'model_reasoning_effort=medium',
    ]);
    expect(buildControlArgs(codexLike, {})).toEqual([
      '-c',
      'model_reasoning_effort=medium',
    ]);
  });

  it('never emits an empty effort for any built-in CLI adapter', () => {
    const cliAdapters = BUILTIN_ADAPTERS
      .map((raw) => adapterSchema.parse(raw))
      .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty');

    for (const item of cliAdapters) {
      for (const blank of ['', '   ', undefined]) {
        const args = buildControlArgs(item, { effort: blank });
        expect(args.some((arg) => /(?:effort|reasoning)[^\s]*=$/.test(arg))).toBe(false);
      }
    }
  });

  it('emits a concrete effort value for every advertised built-in CLI level', () => {
    const cliAdapters = BUILTIN_ADAPTERS
      .map((raw) => adapterSchema.parse(raw))
      .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty');

    for (const item of cliAdapters) {
      for (const level of item.control.effort?.levels ?? []) {
        const args = buildControlArgs(item, { effort: level });
        expect(args.join(' ')).toContain(level);
        expect(args.some((arg) => /(?:effort|reasoning)[^\s]*=$/.test(arg))).toBe(false);
      }
    }
  });

  it('applies full-auto (not manual) for empty choices when yolo exists — system default', () => {
    expect(buildControlArgs(CLAUDE_LIKE, {})).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: '', effort: '' })).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('ignores an effort level the adapter does not support', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { effort: 'ultra' })).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('never auto-enables acceptEdits from an adapter default without yolo', () => {
    const withDefault = adapter({
      permission: {
        arg: '--permission-mode',
        modes: { auto: 'acceptEdits' },
        yolo: [],
        default: 'auto',
      },
    });
    expect(buildControlArgs(withDefault, {})).toEqual([]);
  });

  it('lists the available modes including yolo', () => {
    expect(availablePermissionModes(CLAUDE_LIKE)).toEqual(
      expect.arrayContaining(['bypass', 'auto', 'plan', 'default', 'yolo']),
    );
    expect(supportsVerbose(CLAUDE_LIKE)).toBe(true);
  });

  it('defaults every capable provider to its strongest automatic mode', () => {
    expect(defaultPermissionMode(CLAUDE_LIKE)).toBe('yolo');
    expect(
      defaultPermissionMode(
        adapter({
          permission: {
            arg: '--permission-mode',
            modes: { bypass: 'bypassPermissions' },
            yolo: [],
            default: '',
          },
        }),
      ),
    ).toBe('bypass');
  });

  it('offers no modes for an adapter without a permission block', () => {
    expect(availablePermissionModes(adapter({}))).toEqual([]);
    expect(defaultPermissionMode(adapter({}))).toBe('');
    expect(buildControlArgs(adapter({}), { permissionMode: 'yolo' })).toEqual([]);
  });

  it('defaults every built-in adapter backed by Claude CLI to total bypass', () => {
    const claudeBacked = BUILTIN_ADAPTERS
      .map((raw) => adapterSchema.parse(raw))
      .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty' && item.bin === 'claude');
    expect(claudeBacked.map((item) => item.id)).toEqual(['claude', 'glm', 'glm-flash', 'longcat', 'muse-claude', 'deepseek']);
    for (const item of claudeBacked) {
      expect(defaultPermissionMode(item)).toBe('yolo');
      expect(buildControlArgs(item, { permissionMode: 'yolo' }))
        .toContain('--dangerously-skip-permissions');
    }
  });

  it('does not pass unsupported max effort to AGY 1.2', () => {
    const agy = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw))
      .find((item): item is CliPtyAdapter => item.kind === 'cli-pty' && item.id === 'agy')!;
    expect(buildControlArgs(agy, { effort: 'max' })).not.toContain('max');
    expect(buildControlArgs(agy, { effort: 'high' })).toContain('high');
  });

  it('defaults every writable built-in CLI with a native auto flag to full-auto', () => {
    const cliAdapters = BUILTIN_ADAPTERS
      .map((raw) => adapterSchema.parse(raw))
      .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty');

    for (const item of cliAdapters) {
      const yolo = item.control.permission?.yolo ?? [];
      if (yolo.length === 0) continue;
      expect(defaultPermissionMode(item), item.id).toBe('yolo');
      const args = buildControlArgs(item, { permissionMode: 'yolo' });
      for (const flag of yolo) expect(args, item.id).toContain(flag);
      for (const safe of item.control.permission?.safe ?? []) {
        expect(args, item.id).not.toContain(safe);
      }
    }
  });
});
