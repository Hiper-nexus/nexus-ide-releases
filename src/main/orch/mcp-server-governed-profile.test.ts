import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import type { AgentSpawnDecoration } from '../pty/pty-manager';
import type { BoundSpawnAuthority } from './spawn-authority';
import { getContext, resetGateForTests } from './gate';
import { snapshotSquadAuthority } from './squad-authority-snapshot';

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  dialog: { showMessageBox: vi.fn() },
}));

import {
  hasApprovedMissionProjectTrust,
  prepareAgentSpawnDecoration,
} from './mcp-server';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-wiring-'));
  roots.push(root);
  return root;
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function adapter(
  id: 'claude' | 'codex' | 'agy' | 'opencode' | 'kimi' | 'grok' | 'omp',
): CliPtyAdapter {
  const claudeFamily = id === 'claude';
  return {
    id,
    label: id,
    bin: `/mock/bin/${id}`,
    env: { static: {}, passthrough: [], ephemeralHome: false },
    quirks: {
      mcpAutoload: claudeFamily,
      nexusMcp: claudeFamily ? 'autoload' : id,
    },
  } as unknown as CliPtyAdapter;
}

function authority(
  cwd: string,
  governed: boolean,
  unrestricted = false,
): BoundSpawnAuthority {
  const scope = {
    version: 1 as const,
    installationId: 'installation-wiring',
    projectId: 'project-wiring',
    checkoutId: 'checkout-wiring',
    rootRealPath: cwd,
    identitySource: 'provisional' as const,
  };
  return {
    source: governed ? 'pending' : 'direct-user',
    cwd,
    scope,
    coordinationScope: scope,
    context: governed
      ? {
          missionId: 'mission-wiring',
          contextRevision: unrestricted ? undefined : 'revision-wiring',
          workerIncarnationId: 'worker-wiring',
          role: 'worker',
          allowedTools: unrestricted ? null : [],
          allowedSkills: unrestricted ? null : ['allowed'],
          scope,
          executionScope: scope,
        }
      : null,
  };
}

function sealedMissionAuthority(
  cwd: string,
  overrides: {
    source?: BoundSpawnAuthority['source'];
    role?: 'orchestrator' | 'worker';
    contextRevision?: string;
    missionId?: string;
  } = {},
): BoundSpawnAuthority {
  const base = authority(cwd, true);
  const role = overrides.role ?? 'orchestrator';
  const seal = {
    intentVersion: 1,
    intentContractHash: 'a'.repeat(64),
    contextRevision: 'b'.repeat(64),
    contractHash: 'c'.repeat(64),
    squadRevisionHash: 'd'.repeat(64),
  };
  return {
    ...base,
    source: overrides.source ?? 'pending',
    context: {
      ...base.context!,
      missionId: overrides.missionId ?? 'mission-wiring',
      role,
      workerIncarnationId: role === 'worker' ? 'worker-wiring' : undefined,
      contextRevision: overrides.contextRevision ?? seal.contextRevision,
      authoritySeal: seal,
      allowedSkills: [],
    },
  };
}

function petAuthority(
  cwd: string,
  overrides: {
    source?: BoundSpawnAuthority['source'];
    squadId?: string;
    allowedTools?: string[] | null;
    missionId?: string;
    stalePersistedSeal?: boolean;
  } = {},
): BoundSpawnAuthority {
  const scope = {
    version: 1 as const,
    installationId: 'installation-pet-wiring',
    projectId: 'project-pet-wiring',
    checkoutId: 'checkout-pet-wiring',
    rootRealPath: cwd,
    identitySource: 'provisional' as const,
  };
  const maker = PET_STUDIO_SQUAD.agents[0]!;
  const source = overrides.source ?? 'legacy-squad';
  const persisted = source === 'persisted-pane';
  const contextRevision = persisted ? 'pet-context-revision' : undefined;
  return {
    source,
    cwd,
    scope,
    coordinationScope: scope,
    context: {
      ...(overrides.missionId || persisted
        ? { missionId: overrides.missionId ?? 'mission-pet-wiring' }
        : {}),
      squadId: overrides.squadId ?? PET_STUDIO_SQUAD.id,
      agentName: maker.agentName,
      role: 'orchestrator',
      allowedTools:
        overrides.allowedTools ?? [...(maker.allowedTools ?? [])],
      allowedSkills: [...(maker.allowedSkills ?? [])],
      ...(contextRevision ? { contextRevision } : {}),
      ...(persisted
        ? {
            authoritySeal: {
              intentVersion: 1,
              intentContractHash: 'a'.repeat(64),
              contextRevision: contextRevision!,
              contractHash: 'b'.repeat(64),
              squadRevisionHash: overrides.stalePersistedSeal
                ? 'c'.repeat(64)
                : snapshotSquadAuthority(PET_STUDIO_SQUAD).hash,
            },
          }
        : {}),
      scope,
      executionScope: scope,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetGateForTests();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('mcp-server governed CLI profile wiring', () => {
  it('projects Claude trust only from an exact sealed mission authority', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    const realProfile = JSON.stringify({
      projects: { [cwd]: { hasTrustDialogAccepted: false } },
    });
    write(path.join(home, '.claude.json'), realProfile);

    const exactAuthority = sealedMissionAuthority(cwd);
    expect(hasApprovedMissionProjectTrust(exactAuthority)).toBe(true);
    const decoration = prepareAgentSpawnDecoration(
      adapter('claude'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      exactAuthority,
      undefined,
    );
    if (!decoration) throw new Error('expected Claude mission decoration');
    const overlay = JSON.parse(
      fs.readFileSync(path.join(decoration.env.HOME, '.claude.json'), 'utf8'),
    ) as { projects?: Record<string, Record<string, unknown>> };
    expect(overlay.projects).toEqual({
      [cwd]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(
      realProfile,
    );

    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { source: 'direct-user' }),
      ),
    ).toBe(false);
    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { source: 'legacy-squad' }),
      ),
    ).toBe(false);
    expect(
      hasApprovedMissionProjectTrust(
        sealedMissionAuthority(cwd, { contextRevision: 'e'.repeat(64) }),
      ),
    ).toBe(false);

    decoration.onSpawnFailed?.();
  });

  it('mints Pet media authority only from the exact immediate or sealed resume profile', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const exactImmediate = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd),
      undefined,
    );
    if (!exactImmediate) throw new Error('expected immediate Pet decoration');
    expect(
      getContext(exactImmediate.env.NEXUS_MCP_TOKEN),
    ).toMatchObject({
      role: 'orchestrator',
      missionId: undefined,
      petStudioMediaAuthority: true,
    });

    const exactResume = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd, { source: 'persisted-pane' }),
      undefined,
    );
    if (!exactResume) throw new Error('expected resumed Pet decoration');
    expect(
      getContext(exactResume.env.NEXUS_MCP_TOKEN)?.petStudioMediaAuthority,
    ).toBe(true);

    const deniedAuthorities = [
      petAuthority(cwd, { squadId: 'lookalike-pet-studio' }),
      petAuthority(cwd, {
        allowedTools: [
          ...(PET_STUDIO_SQUAD.agents[0]!.allowedTools ?? []),
          'nexus_video_generate',
        ],
      }),
      petAuthority(cwd, { source: 'direct-user' }),
      petAuthority(cwd, {
        source: 'persisted-pane',
        stalePersistedSeal: true,
      }),
    ];
    const deniedDecorations = deniedAuthorities.map((candidate) => {
      const decoration = prepareAgentSpawnDecoration(
        adapter('codex'),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        candidate,
        undefined,
      );
      if (!decoration) throw new Error('expected denied-profile decoration');
      return decoration;
    });
    for (const decoration of deniedDecorations) {
      expect(
        getContext(decoration.env.NEXUS_MCP_TOKEN)
          ?.petStudioMediaAuthority,
      ).toBeUndefined();
    }

    exactImmediate.onSpawnFailed?.();
    exactResume.onSpawnFailed?.();
    for (const decoration of deniedDecorations) {
      decoration.onSpawnFailed?.();
    }
  });

  it('marks an unrestricted mission Codex worker without PREVC as governed', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    const decoration = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true, true),
      undefined,
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Codex spawn decoration');

    expect(getContext(decoration.env.NEXUS_MCP_TOKEN)).toMatchObject({
      role: 'worker',
      missionId: 'mission-wiring',
      allowedTools: null,
      allowedSkills: null,
      governedNativeProvider: 'codex',
    });
    expect(
      getContext(decoration.env.NEXUS_MCP_TOKEN)?.contextRevision,
    ).toBeUndefined();
    decoration.onSpawnFailed?.();
  });

  it('pre-approves only main-owned mission/Pet Codex bearer servers', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cwd = fs.realpathSync(workspace);
    vi.stubEnv('HOME', home);

    const sealed = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      sealedMissionAuthority(cwd, { role: 'worker' }),
      undefined,
    );
    const unsealed = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, true),
      undefined,
    );
    const direct = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      undefined,
    );
    const pet = prepareAgentSpawnDecoration(
      adapter('codex'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      petAuthority(cwd),
      undefined,
    );
    if (!sealed || !unsealed || !direct || !pet) {
      throw new Error('expected Codex spawn decorations');
    }

    for (const governed of [sealed, unsealed, pet]) {
      const args = governed.extraArgs.join(' ');
      expect(args).toContain('default_tools_approval_mode="approve"');
      expect(
        args.match(/default_tools_approval_mode="approve"/g),
      ).toHaveLength(1);
    }
    expect(direct.extraArgs.join(' ')).not.toContain(
      'default_tools_approval_mode',
    );

    sealed.onSpawnFailed?.();
    unsealed.onSpawnFailed?.();
    direct.onSpawnFailed?.();
    pet.onSpawnFailed?.();
  });

  it('derives confinement from the minted gate token without seeding real profiles', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);

    // One trusted source skill. No provider target contains it before spawn.
    write(
      path.join(home, '.agents', 'skills', 'allowed', 'SKILL.md'),
      '# allowed',
    );
    write(
      path.join(home, '.agents', 'skills', 'blocked', 'SKILL.md'),
      '# blocked',
    );
    write(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-codex-mcp"\n',
    );
    write(
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        plugins: ['external-agy-plugin'],
        mcpServers: { external: { command: 'external-agy-mcp' } },
      }),
    );
    write(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        plugin: ['external-opencode-plugin'],
        mcp: { external: { command: ['external-opencode-mcp'] } },
      }),
    );
    write(
      path.join(home, '.kimi-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: { external: { command: 'external-kimi-mcp' } },
      }),
    );
    write(
      path.join(home, '.grok', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-grok-mcp"\n' +
        '\n[plugins]\nenabled = ["external-grok-plugin"]\n',
    );
    write(
      path.join(home, '.omp', 'agent', 'mcp.json'),
      JSON.stringify({
        plugins: ['external-omp-plugin'],
        mcpServers: { external: { command: 'external-omp-mcp' } },
      }),
    );
    write(
      path.join(cwd, '.grok', 'skills', 'project-only', 'SKILL.md'),
      '# project only',
    );
    write(
      path.join(cwd, '.grok', 'plugins', 'project-plugin', 'plugin.json'),
      '{}',
    );

    const decorations = new Map<string, AgentSpawnDecoration>();
    for (const id of [
      'codex',
      'agy',
      'opencode',
      'kimi',
      'grok',
      'omp',
    ] as const) {
      const preparedEnv: Readonly<Record<string, string>> | undefined =
        id === 'agy'
          ? { GEMINI_CLI_HOME: path.join(home, '.gemini') }
          : id === 'kimi'
            ? { KIMI_CODE_HOME: path.join(home, '.kimi-code') }
            : id === 'grok'
              ? { GROK_HOME: path.join(home, '.grok') }
              : undefined;
      const decoration = prepareAgentSpawnDecoration(
        adapter(id),
        { kind: 'cli-agent', cols: 80, rows: 24 },
        authority(cwd, true),
        preparedEnv,
      );
      expect(decoration).not.toBeNull();
      decorations.set(id, decoration!);
    }

    const codex = decorations.get('codex')!;
    expect(codex.extraArgs.join(' ')).toContain('mcp_servers.nexus_');
    expect(
      getContext(codex.env.NEXUS_MCP_TOKEN)?.governedNativeProvider,
    ).toBe('codex');
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'allowed'))).toBe(
      false,
    );

    const agy = decorations.get('agy')!;
    expect(
      getContext(agy.env.NEXUS_MCP_TOKEN)?.governedNativeProvider,
    ).toBeUndefined();
    expect(agy.env.HOME).not.toBe(home);
    expect(
      fs.readFileSync(
        path.join(agy.env.HOME, '.gemini', 'config', 'mcp_config.json'),
        'utf8',
      ),
    ).not.toContain('external-agy');
    expect(
      fs.existsSync(
        path.join(
          agy.env.GEMINI_CLI_HOME,
          'config',
          'skills',
          'allowed',
          'SKILL.md',
        ),
      ),
    ).toBe(true);

    const opencode = decorations.get('opencode')!;
    expect(opencode.extraArgs).toContain('--pure');
    expect(opencode.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(opencode.env.OPENCODE_CONFIG_CONTENT).not.toContain('external-');

    const kimi = decorations.get('kimi')!;
    expect(kimi.extraArgs).toContain('--skills-dir');
    expect(
      fs.readFileSync(path.join(kimi.env.KIMI_CODE_HOME, 'mcp.json'), 'utf8'),
    ).not.toContain('external-kimi-mcp');

    const grok = decorations.get('grok')!;
    expect(grok.extraArgs).toContain('--no-subagents');
    expect(grok.env.GROK_FOLDER_TRUST).toBeUndefined();
    expect(grok.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('false');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).not.toContain('external-grok');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).toContain('project-plugin');
    expect(
      fs.readFileSync(path.join(grok.env.GROK_HOME, 'config.toml'), 'utf8'),
    ).toContain(path.join(cwd, '.grok', 'skills'));

    const omp = decorations.get('omp')!;
    expect(omp.env.HOME).not.toBe(home);
    expect(
      fs.readFileSync(
        path.join(omp.env.HOME, '.omp', 'agent', 'mcp.json'),
        'utf8',
      ),
    ).not.toContain('external-omp');

    // The real provider profiles remain untouched; allowlisted skills exist
    // only in each private runtime.
    for (const providerSkillRoot of [
      path.join(home, '.codex', 'skills'),
      path.join(home, '.gemini', 'config', 'skills'),
      path.join(home, '.config', 'opencode', 'skills'),
      path.join(home, '.kimi-code', 'skills'),
      path.join(home, '.grok', 'skills'),
      path.join(home, '.omp', 'agent', 'skills'),
    ]) {
      expect(fs.existsSync(path.join(providerSkillRoot, 'allowed'))).toBe(
        false,
      );
    }

    for (const decoration of decorations.values()) {
      decoration?.onSpawnFailed?.();
    }
  });

  it('preserves the full real profile for a direct pane', () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    write(
      path.join(home, '.grok', 'config.toml'),
      '[mcp_servers.external]\ncommand = "external-direct-mcp"\n' +
        '\n[plugins]\nenabled = ["external-direct-plugin"]\n',
    );

    const decoration = prepareAgentSpawnDecoration(
      adapter('grok'),
      { kind: 'cli-agent', cols: 80, rows: 24 },
      authority(cwd, false),
      { GROK_HOME: path.join(home, '.grok') },
    );
    expect(decoration).not.toBeNull();
    if (!decoration) throw new Error('expected Grok spawn decoration');
    const config = fs.readFileSync(
      path.join(decoration.env.GROK_HOME, 'config.toml'),
      'utf8',
    );

    expect(config).toContain('external-direct-mcp');
    expect(config).toContain('external-direct-plugin');
    expect(decoration.extraArgs).not.toContain('--no-subagents');
    expect(decoration.env.HOME).toBeUndefined();
    decoration.onSpawnFailed?.();
  });
});
