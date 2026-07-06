import { describe, expect, it } from 'vitest';
import {
  availablePermissionModes,
  buildControlArgs,
  defaultPermissionMode,
  supportsVerbose,
} from './control-args';
import type { CliPtyAdapter } from '../../shared/adapter-types';

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
    quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false },
    control,
  } as CliPtyAdapter;
}

const CLAUDE_LIKE = adapter({
  permission: {
    arg: '--permission-mode',
    modes: { bypass: 'bypassPermissions', auto: 'acceptEdits', plan: 'plan', default: 'default' },
    yolo: ['--dangerously-skip-permissions'],
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

  it('adds effort and verbose flags when chosen', () => {
    expect(
      buildControlArgs(CLAUDE_LIKE, { effort: 'high', verbose: true }),
    ).toEqual(['--effort', 'high', '--verbose']);
  });

  it('emits nothing for CLI-default (empty) choices', () => {
    expect(buildControlArgs(CLAUDE_LIKE, {})).toEqual([]);
    expect(buildControlArgs(CLAUDE_LIKE, { permissionMode: '', effort: '' })).toEqual([]);
  });

  it('ignores an effort level the adapter does not support', () => {
    expect(buildControlArgs(CLAUDE_LIKE, { effort: 'ultra' })).toEqual([]);
  });

  it('falls back to the adapter default permission mode', () => {
    const withDefault = adapter({
      permission: { arg: '--permission-mode', modes: { auto: 'acceptEdits' }, yolo: [], default: 'auto' },
    });
    expect(buildControlArgs(withDefault, {})).toEqual(['--permission-mode', 'acceptEdits']);
  });

  it('lists the available modes including yolo', () => {
    expect(availablePermissionModes(CLAUDE_LIKE)).toEqual(
      expect.arrayContaining(['bypass', 'auto', 'plan', 'default', 'yolo']),
    );
    expect(supportsVerbose(CLAUDE_LIKE)).toBe(true);
  });

  it('defaults providers to yolo first, then bypass when yolo is unavailable', () => {
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
});
