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

  it('F-748: o argv do Qwen nunca junta --yolo com --approval-mode (o Qwen 0.24 recusa e sai 1)', () => {
    // 02/10: "+ Pane" Qwen imprimia o --help e morria — "Cannot use both
    // --yolo (-y) and --approval-mode together". O base trazia
    // `--approval-mode auto-edit` e o modo padrão somava `--yolo`.
    const qwen = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw))
      .find((item): item is CliPtyAdapter => item.kind === 'cli-pty' && item.id === 'qwen')!;
    for (const permissionMode of ['', 'yolo', ...availablePermissionModes(qwen)]) {
      const argv = [...qwen.spawn.interactive, ...buildControlArgs(qwen, { permissionMode })];
      const approvals = argv.filter((arg) => arg === '--approval-mode').length;
      const yolo = argv.includes('--yolo') || argv.includes('-y');
      expect(yolo && approvals > 0, `${permissionMode}: ${argv.join(' ')}`).toBe(false);
      expect(approvals, `${permissionMode}: ${argv.join(' ')}`).toBeLessThanOrEqual(1);
    }
    expect(qwen.spawn.interactive).not.toContain('--approval-mode');
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

  it('maps permission modes (default, auto, yolo) to concrete argv across adapters', () => {
    const byId = new Map(
      BUILTIN_ADAPTERS
        .map((raw) => adapterSchema.parse(raw))
        .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty')
        .map((item) => [item.id, item]),
    );

    // Claude
    const claude = byId.get('claude')!;
    expect(buildControlArgs(claude, { permissionMode: 'default' })).toEqual(['--permission-mode', 'default']);
    expect(buildControlArgs(claude, { permissionMode: 'auto' })).toEqual(['--permission-mode', 'acceptEdits']);
    expect(buildControlArgs(claude, { permissionMode: 'yolo' })).toEqual([
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
    ]);

    // Codex
    const codex = byId.get('codex')!;
    expect(buildControlArgs(codex, { permissionMode: 'default' })).toEqual([
      '--ask-for-approval',
      'on-request',
      '-c',
      'model_reasoning_effort=medium',
    ]);
    expect(buildControlArgs(codex, { permissionMode: 'auto' })).toEqual([
      '--ask-for-approval',
      'never',
      '-c',
      'model_reasoning_effort=medium',
    ]);
    expect(buildControlArgs(codex, { permissionMode: 'yolo' })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_reasoning_effort=medium',
    ]);

    // Kimi
    const kimi = byId.get('kimi')!;
    expect(buildControlArgs(kimi, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(kimi, { permissionMode: 'auto' })).toEqual([]);
    expect(buildControlArgs(kimi, { permissionMode: 'plan' })).toEqual([]);
    expect(buildControlArgs(kimi, { permissionMode: 'yolo' })).toEqual(['--auto']);

    // Grok
    const grok = byId.get('grok')!;
    expect(buildControlArgs(grok, { permissionMode: 'default' })).toEqual(['--permission-mode', 'default']);
    expect(buildControlArgs(grok, { permissionMode: 'auto' })).toEqual(['--permission-mode', 'acceptEdits']);
    expect(buildControlArgs(grok, { permissionMode: 'yolo' })).toEqual(['--always-approve']);

    // AGY
    const agy = byId.get('agy')!;
    expect(buildControlArgs(agy, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(agy, { permissionMode: 'auto' })).toEqual(['--mode', 'accept-edits']);
    expect(buildControlArgs(agy, { permissionMode: 'yolo' })).toEqual(['--dangerously-skip-permissions']);

    // Qwen
    const qwen = byId.get('qwen')!;
    expect(buildControlArgs(qwen, { permissionMode: 'default' })).toEqual(['--approval-mode', 'default']);
    expect(buildControlArgs(qwen, { permissionMode: 'auto' })).toEqual(['--approval-mode', 'auto-edit']);
    expect(buildControlArgs(qwen, { permissionMode: 'yolo' })).toEqual(['--yolo']);

    // Devin
    const devin = byId.get('devin')!;
    expect(buildControlArgs(devin, { permissionMode: 'default' })).toEqual(['--permission-mode', 'auto']);
    expect(buildControlArgs(devin, { permissionMode: 'auto' })).toEqual(['--permission-mode', 'accept-edits']);
    expect(buildControlArgs(devin, { permissionMode: 'yolo' })).toEqual(['--permission-mode', 'dangerous']);

    // Muse
    const muse = byId.get('muse')!;
    expect(buildControlArgs(muse, { permissionMode: 'default' })).toEqual(['--approval-mode', 'on-request']);
    expect(buildControlArgs(muse, { permissionMode: 'auto' })).toEqual(['--approval-mode', 'never']);
    expect(buildControlArgs(muse, { permissionMode: 'yolo' })).toEqual(['--yolo']);

    // MiMo
    const mimo = byId.get('mimo-code')!;
    expect(buildControlArgs(mimo, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(mimo, { permissionMode: 'yolo' })).toEqual(['--dangerously-skip-permissions']);

    // OpenCode
    const opencode = byId.get('opencode')!;
    expect(buildControlArgs(opencode, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(opencode, { permissionMode: 'yolo' })).toEqual(['--auto']);

    // Aider
    const aider = byId.get('aider')!;
    expect(buildControlArgs(aider, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(aider, { permissionMode: 'yolo' })).toEqual(['--yes-always']);

    // Minimax Code (no CLI flag for yolo)
    const minimax = byId.get('minimax-code')!;
    expect(buildControlArgs(minimax, { permissionMode: 'default' })).toEqual([]);
    expect(buildControlArgs(minimax, { permissionMode: 'yolo' })).toEqual([]);
  });
});
