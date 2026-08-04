import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/types';
import type { SquadAgent } from '../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import {
  buildCustomRosterAgent,
  planRemoveRosterAgent,
} from './mission-roster-customize';

const orch: SquadAgent = {
  id: 'orch',
  agentName: 'Maestro',
  category: 'orchestrator',
  cli: 'claude',
  model: 'claude-sonnet-5',
  effort: 'medium',
  allowedTools: null,
};

const exec: SquadAgent = {
  id: 'exec',
  agentName: 'Executor',
  category: 'executor',
  cli: 'codex',
  model: 'gpt-5.4',
  effort: 'medium',
  allowedTools: ['Bash', 'Read', 'Edit'],
};

function adapter(
  id: string,
  overrides: Partial<AdapterInfo> = {},
): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label: id,
    icon: '◇',
    models: { list: [`${id}-model`], default: `${id}-model` },
    installed: true,
    orchestratorCapable: id === 'claude',
    orchestrationEvidence: id === 'claude' ? 'verified' : 'unsupported',
    autonomousWorkspaceWriteCapable: true,
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: true,
      verifiedMaestro: id === 'claude',
    },
    installCommand: '',
    idleTimeoutMs: 800,
    ...overrides,
  };
}

function provider(adapterId: string): ProviderSettingsInfo {
  return {
    adapterId,
    label: adapterId,
    icon: '◇',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: adapterId,
    defaultModel: `${adapterId}-model`,
    models: [`${adapterId}-model`],
    authReadyModels: [`${adapterId}-model`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: adapterId,
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  };
}

describe('mission-roster-customize', () => {
  it('builds a worker on an unused CLI when possible', () => {
    const result = buildCustomRosterAgent({
      category: 'executor',
      roster: [orch, exec],
      adapters: [adapter('claude'), adapter('codex'), adapter('kimi')],
      providers: [provider('claude'), provider('codex'), provider('kimi')],
      now: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.cli).toBe('kimi');
    expect(result.agent.category).toBe('executor');
    expect(result.agent.allowedTools).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('refuses to remove the last worker', () => {
    const result = planRemoveRosterAgent([orch, exec], 'exec');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ao menos um worker/i);
  });

  it('removes a surplus worker', () => {
    const rev: SquadAgent = {
      ...exec,
      id: 'rev',
      agentName: 'QA',
      category: 'reviewer',
      allowedTools: ['Bash', 'Read'],
    };
    const result = planRemoveRosterAgent([orch, exec, rev], 'rev');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.map((a) => a.id)).toEqual(['orch', 'exec']);
  });
});
