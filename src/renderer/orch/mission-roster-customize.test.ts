import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/types';
import type { SquadAgent } from '../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import {
  buildCustomRosterAgent,
  decideRosterContextChange,
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

const customRoleLaneCases = [
  { lane: 'consult', category: 'executor', allowedTools: ['Read'] },
  { lane: 'consult', category: 'reviewer', allowedTools: ['Read'] },
  { lane: 'consult', category: 'scout', allowedTools: ['Read'] },
  { lane: 'plan', category: 'executor', allowedTools: ['Read'] },
  { lane: 'plan', category: 'reviewer', allowedTools: ['Read'] },
  { lane: 'plan', category: 'scout', allowedTools: ['Read'] },
  { lane: 'ops', category: 'executor', allowedTools: ['Bash', 'Read'] },
  { lane: 'ops', category: 'reviewer', allowedTools: ['Bash', 'Read'] },
  { lane: 'ops', category: 'scout', allowedTools: ['Bash', 'Read'] },
  {
    lane: 'standard',
    category: 'executor',
    allowedTools: ['Bash', 'Read', 'Edit'],
  },
  {
    lane: 'standard',
    category: 'reviewer',
    allowedTools: ['Bash', 'Read'],
  },
  {
    lane: 'standard',
    category: 'scout',
    allowedTools: ['Bash', 'Read'],
  },
] as const;

describe('mission-roster-customize', () => {
  it('builds a worker on an unused CLI when possible', () => {
    const input = {
      category: 'executor' as const,
      lane: 'standard' as const,
      roster: [orch, exec],
      adapters: [adapter('claude'), adapter('codex'), adapter('kimi')],
      providers: [provider('claude'), provider('codex'), provider('kimi')],
      now: 1,
    };
    const result = buildCustomRosterAgent(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.cli).toBe('kimi');
    expect(result.agent.category).toBe('executor');
    expect(result.agent.allowedTools).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('skips a CLI without a declared catalog instead of aborting the whole add', () => {
    const result = buildCustomRosterAgent({
      category: 'executor',
      lane: 'standard',
      roster: [orch, exec],
      // Adapter manual do operador: sem catálogo declarado, e primeiro da fila.
      adapters: [
        adapter('qoder', { models: { list: [], default: '' } }),
        adapter('kimi'),
      ],
      providers: [provider('qoder'), provider('kimi')],
      now: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.cli).toBe('kimi');
  });

  it('still adds a CLI without catalog when it is the only one — modelo é o padrão da ferramenta', () => {
    const result = buildCustomRosterAgent({
      category: 'executor',
      lane: 'standard',
      roster: [orch, exec],
      adapters: [adapter('qoder', { models: { list: [], default: '' } })],
      providers: [provider('qoder')],
      now: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.cli).toBe('qoder');
    expect(result.agent.model).toBe('');
  });

  it.each(customRoleLaneCases)(
    'grants a custom $category only the $lane lane tool policy',
    ({ lane, category, allowedTools }) => {
      const input = {
        category,
        lane,
        roster: [orch, exec],
        adapters: [adapter('claude'), adapter('codex'), adapter('kimi')],
        providers: [provider('claude'), provider('codex'), provider('kimi')],
        now: 2,
      };

      const result = buildCustomRosterAgent(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.agent).toMatchObject({
        id: `custom-${category}-2`,
        category,
        cli: 'kimi',
        model: 'kimi-model',
        allowedTools,
      });
    },
  );

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

describe('decideRosterContextChange (part c: no silent roster rebuild)', () => {
  const key = (squadId: string, policy: string) => `${squadId}${policy}`;

  it('is idle when neither the squad nor the policy changed', () => {
    expect(
      decideRosterContextChange({
        previousSquadId: 'sq-1',
        previousPolicyKey: key('sq-1', 'governed'),
        nextSquadId: 'sq-1',
        nextPolicyKey: key('sq-1', 'governed'),
        userEdited: true,
      }),
    ).toEqual({ action: 'idle' });
  });

  it('rebuilds when the SQUAD changes, even with unsaved edits (edits belong to the old squad)', () => {
    expect(
      decideRosterContextChange({
        previousSquadId: 'sq-1',
        previousPolicyKey: key('sq-1', 'governed'),
        nextSquadId: 'sq-2',
        nextPolicyKey: key('sq-2', 'governed'),
        userEdited: true,
      }),
    ).toEqual({ action: 'rebuild' });
  });

  it('PRESERVES edits on a policy/mode switch of the SAME squad (never a silent clobber)', () => {
    expect(
      decideRosterContextChange({
        previousSquadId: 'sq-1',
        previousPolicyKey: key('sq-1', 'governed'),
        nextSquadId: 'sq-1',
        nextPolicyKey: key('sq-1', 'operator-choice'),
        userEdited: true,
      }),
    ).toEqual({ action: 'preserve' });
  });

  it('rebuilds on a policy switch when the roster was never edited (nothing to lose)', () => {
    expect(
      decideRosterContextChange({
        previousSquadId: 'sq-1',
        previousPolicyKey: key('sq-1', 'governed'),
        nextSquadId: 'sq-1',
        nextPolicyKey: key('sq-1', 'operator-choice'),
        userEdited: false,
      }),
    ).toEqual({ action: 'rebuild' });
  });

  it('rebuilds on first load (no previous squad)', () => {
    expect(
      decideRosterContextChange({
        previousSquadId: null,
        previousPolicyKey: null,
        nextSquadId: 'sq-1',
        nextPolicyKey: key('sq-1', 'governed'),
        userEdited: false,
      }),
    ).toEqual({ action: 'rebuild' });
  });
});
