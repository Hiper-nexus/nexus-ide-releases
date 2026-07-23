import { describe, expect, it } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import {
  requiresReadOnlyNativeAuthority,
  secureAutonomousCliArgs,
  supportsEnforceableReadOnlyNativeAuthority,
} from './autonomous-cli-policy';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';

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
    // Coordenadores não implementam nem integram pela CLI nativa. Eles
    // delegam e avançam a integração pelas tools Nexus auditadas.
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      role: 'orchestrator',
    })).toBe(true);
    expect(requiresReadOnlyNativeAuthority({
      source: 'legacy-squad',
      role: 'orchestrator',
    })).toBe(true);
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      role: 'orchestrator',
      readOnly: true,
    })).toBe(true);
    expect(requiresReadOnlyNativeAuthority({
      source: 'direct-user',
      role: 'user',
    })).toBe(false);
  });

  it('reports read-only confinement support before provider side effects', () => {
    expect(
      supportsEnforceableReadOnlyNativeAuthority(
        adapter({ id: 'codex' }),
      ),
    ).toBe(true);
    expect(
      supportsEnforceableReadOnlyNativeAuthority(
        adapter({
          id: 'omp',
          control: {
            permission: {
              safe: [],
              yolo: [],
              modes: {},
              default: '',
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps Codex reviewer panes safe when the user disables full-auto', () => {
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
    expect(args).toContain('on-request');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('makes read-only override Codex YOLO and forces the native sandbox', () => {
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
          modes: { auto: 'never' },
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(
      codex,
      ['--dangerously-bypass-approvals-and-sandbox'],
      true,
    );
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('on-request');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('keeps Codex read-only while allowing unattended audited MCP orchestration', () => {
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
          arg: '--ask-for-approval',
          safe: [
            '--sandbox',
            'workspace-write',
            '--ask-for-approval',
            'on-request',
          ],
          yolo: ['--dangerously-bypass-approvals-and-sandbox'],
          modes: { auto: 'never' },
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(codex, [], true, {
      unattendedNexusMcp: true,
    });

    expect(args).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
    ]);
    expect(args).not.toContain('on-request');
    expect(args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
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

  it('rejects a yolo-only provider even when full-auto was explicitly selected', () => {
    const kimi = adapter({
      id: 'kimi',
      control: { permission: { modes: {}, yolo: ['-y'], default: '' } },
    });
    expect(() => secureAutonomousCliArgs(kimi, ['-y'], true)).toThrow(
      /read-only review confinement/i,
    );
  });

  it('does not trust a provider flag merely because its name contains read-only', () => {
    expect(() => secureAutonomousCliArgs(adapter({
      id: 'plugin-cli',
      control: {
        permission: {
          safe: ['--pretend-read-only'],
          yolo: ['--yolo'],
          modes: {},
          default: '',
        },
      },
    }), [], true)).toThrow(/read-only review confinement/i);
  });

  it('keeps writable Claude workers able to code while loading Nexus MCP', () => {
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
    expect(args).not.toContain('--disallowedTools');

    const coordinatorArgs = secureAutonomousCliArgs(claude, [
      '--dangerously-skip-permissions',
    ], true);
    expect(coordinatorArgs).not.toContain('--dangerously-skip-permissions');
    expect(coordinatorArgs).toContain('dontAsk');
    expect(coordinatorArgs).not.toContain('manual');
    expect(coordinatorArgs).toContain('--disallowedTools');
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task']) {
      expect(coordinatorArgs).toContain(tool);
    }
    expect(coordinatorArgs).not.toContain('Read');
    expect(coordinatorArgs).not.toContain('Glob');
    expect(coordinatorArgs).not.toContain('Grep');
    expect(coordinatorArgs).toContain('--allowedTools');
    expect(coordinatorArgs).toContain('mcp__nexus');
  });

  it('does not upgrade a read-only Claude-family pane to bypassPermissions', () => {
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
          modes: { bypass: 'bypassPermissions' },
          yolo: [
            '--allow-dangerously-skip-permissions',
            '--dangerously-skip-permissions',
          ],
          safe: ['--permission-mode', 'manual'],
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(claude, [
      '--permission-mode',
      'bypassPermissions',
    ], true);

    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('mcp__nexus');
    expect(args).not.toContain('bypassPermissions');
    expect(args).toContain('dontAsk');
    expect(args).not.toContain('manual');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Bash');
    expect(args).toContain('Write');
  });

  it('preserves explicit plan mode on Claude-family panes', () => {
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
          modes: { plan: 'plan', bypass: 'bypassPermissions' },
          yolo: ['--dangerously-skip-permissions'],
          safe: ['--permission-mode', 'manual'],
          default: '',
        },
      },
    });

    const args = secureAutonomousCliArgs(claude, [
      '--permission-mode',
      'plan',
    ]);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
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
      control: { permission: { modes: {}, yolo: ['-y'], default: '' } },
    });
    expect(secureAutonomousCliArgs(kimi, ['-y'])).toEqual(['-y']);
  });

  it('preserves each built-in provider native yolo flag for writable workers', () => {
    const cliAdapters = BUILTIN_ADAPTERS
      .map((raw) => adapterSchema.parse(raw))
      .filter((item): item is CliPtyAdapter => item.kind === 'cli-pty');

    for (const item of cliAdapters) {
      const yolo = item.control.permission?.yolo ?? [];
      if (yolo.length === 0) continue;
      const args = secureAutonomousCliArgs(item, yolo, false);
      for (const flag of yolo) expect(args, item.id).toContain(flag);
      for (const safe of item.control.permission?.safe ?? []) {
        expect(args, item.id).not.toContain(safe);
      }
    }
  });
});
