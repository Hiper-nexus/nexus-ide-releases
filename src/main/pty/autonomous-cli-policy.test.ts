import { describe, expect, it } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import {
  requiresReadOnlyNativeAuthority,
  secureAutonomousCliArgs,
} from './autonomous-cli-policy';

function adapter(
  patch: Partial<CliPtyAdapter> & Pick<CliPtyAdapter, 'id'>,
): CliPtyAdapter {
  return {
    kind: 'cli-pty',
    label: patch.id,
    version: '1',
    icon: '',
    bin: patch.id,
    detect: `${patch.id} --version`,
    install: { method: 'manual', command: '' },
    auth: { method: 'none' },
    spawn: {
      interactive: [patch.id],
      headless: [patch.id],
      ptyRequired: true,
      resumeArgs: [],
      extraArgs: [],
    },
    env: { static: {}, passthrough: [], ephemeralHome: false },
    models: { flag: '', list: ['default'], default: 'default' },
    promptInjection: {
      method: 'arg',
      trailingNewline: false,
      bracketedPaste: false,
    },
    stateParsing: {
      idle: { type: 'timeout', ms: 100 },
      shellIntegration: false,
      exitCodes: {},
    },
    quirks: {
      altScreen: false,
      requiresNoAutoUpdate: false,
      mcpAutoload: false,
    },
    control: {},
    ...patch,
    id: patch.id,
  } as CliPtyAdapter;
}

describe('secureAutonomousCliArgs', () => {
  it('grants provider-native writes only to revision-bound workers', () => {
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      role: 'worker',
      contextRevision: 'context-revision-a',
    })).toBe(false);
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      role: 'worker',
    })).toBe(true);
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      role: 'orchestrator',
      contextRevision: 'context-revision-a',
    })).toBe(true);
    expect(requiresReadOnlyNativeAuthority({
      source: 'direct-user',
      role: 'user',
    })).toBe(false);
  });

  it('forces Codex reviewer panes into read-only/no-approval mode', () => {
    const codex = adapter({
      id: 'codex',
      quirks: {
        altScreen: false,
        requiresNoAutoUpdate: false,
        mcpAutoload: false,
        nexusMcp: 'codex',
      },
      control: {
        permission: {
          safe: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
          yolo: ['--dangerously-bypass-approvals-and-sandbox'],
          modes: {},
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(codex, [], true);
    expect(args).toContain('read-only');
    expect(args).toContain('never');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('on-request');
  });

  it('rejects reviewer providers without enforceable read-only confinement', () => {
    expect(() => secureAutonomousCliArgs(adapter({
      id: 'agy',
      control: {
        permission: {
          safe: ['--approval-mode', 'default'],
          yolo: ['--yolo'],
          modes: {},
          default: '',
        },
      },
    }), [], true))
      .toThrow(/read-only review confinement/i);
  });
  it('forces Claude-like agents onto explicitly allowed Nexus MCP tools', () => {
    const claude = adapter({
      id: 'claude',
      quirks: {
        altScreen: true,
        requiresNoAutoUpdate: false,
        mcpAutoload: true,
        nexusMcp: 'autoload',
      },
      control: {
        permission: {
          arg: '--permission-mode',
          modes: { auto: 'acceptEdits' },
          yolo: ['--dangerously-skip-permissions'],
          safe: ['--permission-mode', 'manual'],
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(claude, [
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
    ]);

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('manual');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('mcp__nexus');
    expect(args).toContain('--disallowedTools');
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task']) {
      expect(args).toContain(tool);
    }
  });

  it('preserves Codex bypass for writable panes', () => {
    const codex = adapter({
      id: 'codex',
      control: {
        permission: {
          arg: '--ask-for-approval',
          modes: { auto: 'never' },
          yolo: ['--dangerously-bypass-approvals-and-sandbox'],
          safe: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(codex, [
      '--dangerously-bypass-approvals-and-sandbox',
    ]);

    expect(args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('rejects adapters with no enforceable autonomous confinement', () => {
    expect(() => secureAutonomousCliArgs(adapter({ id: 'kimi' }), [])).toThrow(
      /does not declare enforceable autonomous confinement/i,
    );
  });

  it('allows a yolo-only provider when full-auto was explicitly selected', () => {
    const kimi = adapter({
      id: 'kimi',
      control: { permission: { modes: {}, yolo: ['--yolo'], default: '' } },
    });
    expect(secureAutonomousCliArgs(kimi, ['--yolo'])).toEqual(['--yolo']);
  });
});
