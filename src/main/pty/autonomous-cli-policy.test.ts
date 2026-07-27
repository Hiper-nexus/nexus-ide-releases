import { describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';

const e2eFlag = vi.hoisted(() => ({ value: false }));
vi.mock('../../shared/real-mission-e2e', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/real-mission-e2e')>()),
  isCurrentProcessRealMissionE2E: () => e2eFlag.value,
}));
import {
  isMissionBoundCodexWorkspaceAuthority,
  isPetStudioNativeWorkspaceAuthority,
  requiresReadOnlyNativeAuthority,
  secureAutonomousCliArgs,
  supportsEnforceableReadOnlyNativeAuthority,
  supportsEnforceableWorkspaceWriteNativeAuthority,
} from './autonomous-cli-policy';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import {
  CODEX_READ_ONLY_PERMISSION_PROFILE,
  CODEX_WORKSPACE_PERMISSION_PROFILE,
} from './codex-native-authority';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import { snapshotSquadAuthority } from '../orch/squad-authority-snapshot';

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

function builtinCli(id: string): CliPtyAdapter {
  return adapterSchema.parse(
    BUILTIN_ADAPTERS.find(
      (raw) => (raw as { id?: string }).id === id,
    ),
  ) as CliPtyAdapter;
}

describe('secureAutonomousCliArgs', () => {
  it('grants provider-native writes to governed Codex mission workers', () => {
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      adapterId: 'codex',
      role: 'worker',
      missionId: 'mission-a',
      contextRevision: 'context-revision-a',
    })).toBe(false);
    expect(requiresReadOnlyNativeAuthority({
      source: 'pending',
      adapterId: 'codex',
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

  it('does not use PREVC or open capability lists as the Codex confinement switch', () => {
    const missionWorker = {
      source: 'pending' as const,
      adapterId: 'codex',
      role: 'worker' as const,
      missionId: 'mission-before-prevc',
      allowedTools: null,
      allowedSkills: null,
    };

    expect(isMissionBoundCodexWorkspaceAuthority(missionWorker)).toBe(true);
    expect(requiresReadOnlyNativeAuthority(missionWorker)).toBe(false);
    expect(
      isMissionBoundCodexWorkspaceAuthority({
        ...missionWorker,
        adapterId: 'kimi',
      }),
    ).toBe(false);
    expect(
      requiresReadOnlyNativeAuthority({
        ...missionWorker,
        adapterId: 'kimi',
      }),
    ).toBe(true);
    expect(
      isMissionBoundCodexWorkspaceAuthority({
        ...missionWorker,
        nativeReadOnly: true,
      }),
    ).toBe(false);
  });

  it('grants the exact built-in Pet maker native workspace authority', () => {
    const maker = PET_STUDIO_SQUAD.agents[0]!;
    const petAuthority = {
      source: 'legacy-squad' as const,
      adapterId: 'codex',
      role: 'orchestrator' as const,
      squadId: PET_STUDIO_SQUAD_ID,
      agentName: maker.agentName,
      allowedTools: maker.allowedTools,
      allowedSkills: maker.allowedSkills,
    };

    expect(isPetStudioNativeWorkspaceAuthority(petAuthority)).toBe(true);
    expect(requiresReadOnlyNativeAuthority(petAuthority)).toBe(false);

    for (const changed of [
      { ...petAuthority, source: 'pending' as const },
      { ...petAuthority, adapterId: 'claude' },
      { ...petAuthority, squadId: 'lookalike-pet-studio' },
      { ...petAuthority, role: 'worker' as const },
      { ...petAuthority, agentName: 'Pet Maker lookalike' },
      { ...petAuthority, allowedTools: maker.allowedTools?.slice(1) },
      { ...petAuthority, allowedSkills: [] },
      { ...petAuthority, nativeReadOnly: true },
      { ...petAuthority, readOnly: true },
      { ...petAuthority, contextRevision: 'unexpected-revision' },
    ]) {
      expect(isPetStudioNativeWorkspaceAuthority(changed)).toBe(false);
      expect(requiresReadOnlyNativeAuthority(changed)).toBe(true);
    }
  });

  it('restores Pet workspace authority only from an exact persisted pane seal', () => {
    const maker = PET_STUDIO_SQUAD.agents[0]!;
    const contextRevision = 'pet-context-revision';
    const persistedPet = {
      source: 'persisted-pane' as const,
      adapterId: 'codex',
      role: 'orchestrator' as const,
      missionId: 'mission-pet',
      squadId: PET_STUDIO_SQUAD_ID,
      agentName: maker.agentName,
      allowedTools: maker.allowedTools,
      allowedSkills: maker.allowedSkills,
      contextRevision,
      authoritySeal: {
        intentVersion: 1,
        intentContractHash: 'a'.repeat(64),
        contextRevision,
        contractHash: 'b'.repeat(64),
        squadRevisionHash: snapshotSquadAuthority(PET_STUDIO_SQUAD).hash,
      },
    };

    expect(isPetStudioNativeWorkspaceAuthority(persistedPet)).toBe(true);
    expect(requiresReadOnlyNativeAuthority(persistedPet)).toBe(false);
    for (const changed of [
      { ...persistedPet, authoritySeal: undefined },
      {
        ...persistedPet,
        authoritySeal: {
          ...persistedPet.authoritySeal,
          squadRevisionHash: 'c'.repeat(64),
        },
      },
      { ...persistedPet, contextRevision: 'stale-context-revision' },
      { ...persistedPet, missionId: '' },
    ]) {
      expect(isPetStudioNativeWorkspaceAuthority(changed)).toBe(false);
      expect(requiresReadOnlyNativeAuthority(changed)).toBe(true);
    }
  });

  it('reports read-only confinement support before provider side effects', () => {
    expect(
      supportsEnforceableReadOnlyNativeAuthority(
        builtinCli('codex'),
      ),
    ).toBe(true);
    expect(
      supportsEnforceableReadOnlyNativeAuthority(builtinCli('claude')),
    ).toBe(true);
    expect(
      supportsEnforceableReadOnlyNativeAuthority(builtinCli('glm')),
    ).toBe(false);
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

  it('qualifies only the exact release-pinned Codex workspace sandbox', () => {
    const parsed = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));
    const codex = parsed.find(
      (item): item is CliPtyAdapter =>
        item.kind === 'cli-pty' && item.id === 'codex',
    )!;

    expect(supportsEnforceableWorkspaceWriteNativeAuthority(codex)).toBe(
      true,
    );
    for (const id of ['kimi', 'opencode', 'omp', 'agy', 'grok']) {
      const candidate = parsed.find(
        (item): item is CliPtyAdapter =>
          item.kind === 'cli-pty' && item.id === id,
      )!;
      expect(
        supportsEnforceableWorkspaceWriteNativeAuthority(candidate),
        id,
      ).toBe(false);
    }
    expect(
      supportsEnforceableWorkspaceWriteNativeAuthority({
        ...codex,
        control: {
          ...codex.control,
          permission: {
            ...codex.control.permission!,
            safe: ['--sandbox', 'workspace-write'],
          },
        },
      }),
    ).toBe(false);
  });

  it('selects the main-owned Codex workspace profile and strips every widening override', () => {
    const codex = adapterSchema.parse(
      BUILTIN_ADAPTERS.find(
        (raw) => (raw as { id?: string }).id === 'codex',
      ),
    ) as CliPtyAdapter;
    const args = secureAutonomousCliArgs(
      codex,
      [
        '--model',
        'gpt-5.5',
        '--dangerously-bypass-approvals-and-sandbox',
        '--add-dir',
        '/tmp/outside',
        '-C',
        '/',
        '-C/tmp/attached',
        '-C=/tmp/equals',
        '-sdanger-full-access',
        '-s=danger-full-access',
        '-adanger-full-access',
        '-a=danger-full-access',
        '-punsafe',
        '-p=unsafe',
        '-c',
        'sandbox_workspace_write.writable_roots=["/"]',
        '-csandbox_workspace_write.writable_roots=["/"]',
        '-c=sandbox_mode="danger-full-access"',
        '-c',
        'model_reasoning_effort=high',
        '-c=model_reasoning_effort=xhigh',
        '-c',
        'mcp_servers.nexus_abcdef123456.url="http://127.0.0.1:4200/mcp"',
        '-c',
        'mcp_servers.nexus_deadbeefcafe.url="https://outside.invalid/mcp"',
        '--sandbox',
        'danger-full-access',
        '--ask-for-approval',
        'never',
        '--remote',
        'cloud-task',
        '--remote-auth-token-env=REMOTE_TOKEN',
        '--enable',
        'web_search',
        '--disable',
        'shell_tool',
        '--oss',
        '--local-provider',
        'ollama',
        '-i',
        '/tmp/image.png',
        '--search',
        '--',
        '-s',
        'danger-full-access',
        '--strict-config',
        '--disable',
        'multi_agent',
      ],
      false,
      {
        enforceWorkspaceWriteSandbox: true,
        trustedWorkspaceModel: 'gpt-5.5',
        trustedWorkspaceConfigOverrides: [
          'mcp_servers.nexus_abcdef123456.url="http://127.0.0.1:4200/mcp"',
        ],
        trustedCodexPermissionProfile:
          CODEX_WORKSPACE_PERMISSION_PROFILE,
      },
    );

    expect(args).toEqual([
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high',
      '-c',
      'model_reasoning_effort=xhigh',
      '-c',
      'mcp_servers.nexus_abcdef123456.url="http://127.0.0.1:4200/mcp"',
      '--strict-config',
      '--disable',
      'multi_agent',
      '--ask-for-approval',
      'never',
    ]);
  });

  it('rebuilds Codex read-only argv after spaced, attached, equals and terminator bypasses', () => {
    const args = secureAutonomousCliArgs(
      builtinCli('codex'),
      [
        '-C/tmp',
        '-s=danger-full-access',
        '-adanger-full-access',
        '-punsafe',
        '-csandbox_mode="danger-full-access"',
        '--config=sandbox_workspace_write.writable_roots=["/"]',
        '--remote=task',
        '--enable=web_search',
        '--oss',
        '--search',
        '--',
        '--sandbox',
        'danger-full-access',
      ],
      true,
      {
        trustedWorkspaceModel: 'gpt-5.5',
        trustedWorkspaceConfigOverrides: [
          'mcp_servers.nexus_abcdef123456.tool_timeout_sec=45',
        ],
        trustedCodexPermissionProfile:
          CODEX_READ_ONLY_PERMISSION_PROFILE,
      },
    );

    expect(args).toEqual([
      '--model',
      'gpt-5.5',
      '-c',
      'mcp_servers.nexus_abcdef123456.tool_timeout_sec=45',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('keeps Codex reviewer panes safe when the user disables full-auto', () => {
    const codex = builtinCli('codex');

    const args = secureAutonomousCliArgs(codex, [], true, {
      trustedCodexPermissionProfile:
        CODEX_READ_ONLY_PERMISSION_PROFILE,
    });
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('on-request');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('makes read-only override Codex YOLO and forces the native sandbox', () => {
    const codex = builtinCli('codex');

    const args = secureAutonomousCliArgs(
      codex,
      ['--dangerously-bypass-approvals-and-sandbox'],
      true,
      {
        trustedCodexPermissionProfile:
          CODEX_READ_ONLY_PERMISSION_PROFILE,
      },
    );
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('on-request');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('keeps Codex read-only while allowing unattended audited MCP orchestration', () => {
    const codex = builtinCli('codex');

    const args = secureAutonomousCliArgs(codex, [], true, {
      unattendedNexusMcp: true,
      trustedCodexPermissionProfile:
        CODEX_READ_ONLY_PERMISSION_PROFILE,
    });

    expect(args).toEqual([
      '--ask-for-approval',
      'never',
    ]);
    expect(args).not.toContain('on-request');
    expect(args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('uses the trusted outer sandbox without globally approving MCP servers', () => {
    const codex = builtinCli('codex');

    const args = secureAutonomousCliArgs(codex, [
      '--dangerously-bypass-approvals-and-sandbox',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ], true, {
      unattendedNexusMcp: true,
      trustedCodexPermissionProfile:
        CODEX_READ_ONLY_PERMISSION_PROFILE,
      trustedCodexExternalProcessSandbox: true,
    });

    expect(args).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'on-request',
    ]);
    expect(args).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
    expect(args).not.toContain('never');
  });

  it('honors the caller approval never under the release-gate e2e doctrine', () => {
    const codex = builtinCli('codex');
    e2eFlag.value = true;
    try {
      const args = secureAutonomousCliArgs(codex, [
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
      ], false, {
        enforceWorkspaceWriteSandbox: true,
        trustedCodexPermissionProfile:
          CODEX_WORKSPACE_PERMISSION_PROFILE,
        trustedCodexExternalProcessSandbox: true,
      });

      expect(args).toEqual([
        '--sandbox',
        'danger-full-access',
        '--ask-for-approval',
        'never',
      ]);
      expect(args).not.toContain('on-request');
    } finally {
      e2eFlag.value = false;
    }
  });

  it('keeps production on-request under the trusted outer sandbox', () => {
    const codex = builtinCli('codex');

    const args = secureAutonomousCliArgs(codex, [
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ], false, {
      enforceWorkspaceWriteSandbox: true,
      trustedCodexPermissionProfile:
        CODEX_WORKSPACE_PERMISSION_PROFILE,
      trustedCodexExternalProcessSandbox: true,
    });

    expect(args).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('preserves hook trust bypass only from the main-owned decoration', () => {
    const codex = builtinCli('codex');
    const trusted = secureAutonomousCliArgs(codex, [
      '--dangerously-bypass-hook-trust',
    ], true, {
      unattendedNexusMcp: true,
      trustedCodexPermissionProfile:
        CODEX_READ_ONLY_PERMISSION_PROFILE,
      trustedCodexExternalProcessSandbox: true,
      trustedDecorationArgs: [
        '--dangerously-bypass-hook-trust',
      ],
    });
    expect(trusted).toContain('--dangerously-bypass-hook-trust');

    const untrusted = secureAutonomousCliArgs(codex, [
      '--dangerously-bypass-hook-trust',
    ], true, {
      unattendedNexusMcp: true,
      trustedCodexPermissionProfile:
        CODEX_READ_ONLY_PERMISSION_PROFILE,
      trustedCodexExternalProcessSandbox: true,
    });
    expect(untrusted).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('fails closed when governed Codex lacks its exact main-owned permission profile', () => {
    expect(() =>
      secureAutonomousCliArgs(builtinCli('codex'), [], true),
    ).toThrow(/main-owned permission profile/i);
    expect(() =>
      secureAutonomousCliArgs(builtinCli('codex'), [], false, {
        enforceWorkspaceWriteSandbox: true,
        trustedCodexPermissionProfile:
          CODEX_READ_ONLY_PERMISSION_PROFILE,
      }),
    ).toThrow(/main-owned permission profile/i);
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
    const claude = builtinCli('claude');

    const args = secureAutonomousCliArgs(claude, [
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
    ]);

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('manual');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('mcp__nexus__*');
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
    expect(coordinatorArgs).toContain('--tools');
    expect(coordinatorArgs).toContain('');
    expect(coordinatorArgs).toContain('--allowedTools');
    expect(coordinatorArgs).toContain('mcp__nexus__*');
  });

  it('does not upgrade a read-only Claude-family pane to bypassPermissions', () => {
    const claude = builtinCli('claude');

    const args = secureAutonomousCliArgs(claude, [
      '--permission-mode',
      'bypassPermissions',
    ], true);

    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('mcp__nexus__*');
    expect(args).toContain('--tools');
    expect(args).toContain('');
    expect(args).not.toContain('bypassPermissions');
    expect(args).toContain('dontAsk');
    expect(args).not.toContain('manual');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Bash');
    expect(args).toContain('Write');
  });

  it('rebuilds Claude read-only argv only from main-owned provider state', () => {
    const args = secureAutonomousCliArgs(
      builtinCli('claude'),
      [
        '--permission-mode=bypassPermissions',
        '--allowedTools=Bash',
        '--allowed-tools',
        'Bash',
        'Edit',
        '--settings',
        '/tmp/user-settings.json',
        '--setting-sources',
        'project,local,user',
        '--mcp-config=/tmp/user-mcp.json',
        '--plugin-dir',
        '/tmp/plugin',
        '--agents',
        '{"evil":{}}',
        '--worktree',
        '/tmp/outside',
        '--remote-control',
        '--resume',
        'user-session',
        '--session-id=user-session',
        '--model',
        'user-model',
        '--',
        '--permission-mode',
        'bypassPermissions',
      ],
      true,
      {
        trustedWorkspaceModel: 'claude-sonnet-5',
        trustedResumeArgs: ['--resume', 'provider-session-main'],
        trustedSessionArgs: ['--session-id', 'session-main'],
        trustedDecorationArgs: [
          '--mcp-config',
          '/private/main/mcp.json',
          '--settings',
          '/private/main/settings.json',
          '--strict-mcp-config',
        ],
      },
    );

    expect(args).toEqual([
      '--model',
      'claude-sonnet-5',
      '--resume',
      'provider-session-main',
      '--session-id',
      'session-main',
      '--mcp-config',
      '/private/main/mcp.json',
      '--settings',
      '/private/main/settings.json',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      '--tools',
      '',
      '--allowedTools',
      'mcp__nexus__*',
      '--disallowedTools',
      'Task',
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
    ]);
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
