import { describe, expect, it } from 'vitest';
import { cliPtyAdapterSchema } from '../../shared/adapter-types';
import type { Squad } from '../../shared/orch-types';
import {
  RETIRED_ROSTER_ROUTE_MARKER,
  RetiredRosterRouteError,
} from '../../shared/retired-adapter-policy';
import {
  assertMissionOrchestratorEvidence,
  canonicalMissionOrchestratorRuntime,
  preferredMissionOrchestratorAdapterId,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
} from './mission-orchestrator-runtime';

const customAdapter = cliPtyAdapterSchema.parse({
  kind: 'cli-pty',
  id: 'custom-cli',
  label: 'Custom CLI',
  version: '1',
  icon: 'C',
  bin: 'custom-cli',
  detect: 'custom-cli --version',
  install: { method: 'manual', command: 'install custom-cli' },
  auth: { method: 'none' },
  spawn: {
    interactive: ['custom-cli'],
    headless: ['custom-cli', '{{PROMPT}}'],
    ptyRequired: true,
  },
  env: {},
  models: {
    flag: '--model',
    list: ['custom-model'],
    default: 'custom-model',
  },
  promptInjection: { method: 'stdin' },
  stateParsing: {
    idle: { type: 'timeout', ms: 500 },
    shellIntegration: false,
  },
  quirks: {},
  control: {},
});

const squad = {
  id: 'squad',
  name: 'Squad',
  createdAt: '2026-07-29T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: '',
  agents: [],
} satisfies Squad;

function productionDeps(
  policy: 'operator-choice' | 'governed',
  options: {
    installed?: boolean;
    handoffCapable?: boolean;
    missionControlCapable?: boolean;
    providerReady?: boolean;
  } = {},
) {
  return {
    getSettings: () => ({
      squadCliPolicy: policy,
      defaultAdapterId: 'claude',
      defaultModel: '',
      defaultAccountId: '',
    }),
    getAdapter: () => customAdapter,
    listAdapterInfos: () => [
      {
        id: customAdapter.id,
        kind: customAdapter.kind,
        label: customAdapter.label,
        icon: customAdapter.icon,
        models: customAdapter.models,
        installed: options.installed ?? true,
        installCommand: customAdapter.install.command,
        idleTimeoutMs: 500,
        orchestratorCapable: false,
        taskHandoffCapable: options.handoffCapable ?? true,
        missionControlCapable: options.missionControlCapable ?? true,
        orchestrationEvidence: 'unsupported' as const,
        autonomousWorkspaceWriteCapable: false,
        capabilities: {
          launchable: true,
          promptInjectable: true,
          statusObservable: true,
          resumable: false,
          autonomousReadOnly: false,
          governedWriter: false,
          verifiedMaestro: false,
        },
      },
    ],
    listAccountInfos: () => [],
    isProviderEnabled: () => true,
    providerReadiness: () => ({
      ready: options.providerReady ?? true,
      reason: 'Custom CLI sem autenticação pronta',
    }),
  };
}

describe('mission orchestrator runtime authority', () => {
  it('canonicalizes every approved runtime field without renderer defaults', () => {
    expect(
      canonicalMissionOrchestratorRuntime({
        adapterId: ' codex ',
        model: ' gpt-5.6-sol ',
        accountId: ' account-a ',
        effort: ' high ',
        readOnly: false,
        nativeReadOnly: true,
      }),
    ).toEqual({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    });
  });

  it('rejects an MCP read-only orchestrator but persists explicit autopilot confinement', () => {
    expect(() =>
      canonicalMissionOrchestratorRuntime({
        adapterId: 'codex',
        readOnly: true,
        nativeReadOnly: true,
      }),
    ).toThrow(/autoridade Main-owned delegável/i);
    expect(
      canonicalMissionOrchestratorRuntime({
        adapterId: 'custom-cli',
        readOnly: false,
        nativeReadOnly: false,
      }),
    ).toEqual({
      adapterId: 'custom-cli',
      readOnly: false,
      nativeReadOnly: false,
    });
  });

  it('uses exact optional-field equality and roster-first adapter selection', () => {
    const approved = canonicalMissionOrchestratorRuntime({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    });
    expect(
      sameMissionOrchestratorRuntime(approved, {
        ...approved,
        accountId: 'account-b',
      }),
    ).toBe(false);
    expect(
      preferredMissionOrchestratorAdapterId({ cli: 'codex' }, 'claude'),
    ).toBe('codex');
  });

  it('permite experimental apenas no roster salvo e bloqueia promoção automática', () => {
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'experimental',
        selection: 'saved-roster',
        label: 'Kimi',
      }),
    ).not.toThrow();
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'experimental',
        selection: 'automatic',
        label: 'Kimi',
      }),
    ).toThrow(/experimental.*promovido automaticamente.*verificado/i);
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'unsupported',
        selection: 'saved-roster',
        label: 'Aider',
      }),
    ).toThrow(/não tem evidência válida/i);
  });

  it('resolves an authenticated PTY-control-capable custom CLI in operator-choice', () => {
    const runtime = resolveProductionMissionOrchestratorRuntime(
      squad,
      {
        id: 'maestro',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'custom-cli',
        model: 'custom-model',
      },
      productionDeps('operator-choice'),
    );

    expect(runtime).toEqual({
      adapterId: 'custom-cli',
      model: 'custom-model',
      readOnly: false,
      nativeReadOnly: false,
    });
  });

  it.each(['omp', 'omp-rpc'] as const)(
    'preserves a retired %s orchestrator seal and requires explicit replanning',
    (retiredId) => {
      expect(() =>
        resolveProductionMissionOrchestratorRuntime(
          squad,
          {
            id: 'legacy-maestro',
            agentName: 'Legacy Maestro',
            category: 'orchestrator',
            cli: retiredId,
          },
          productionDeps('operator-choice'),
        ),
      ).toThrowError(RetiredRosterRouteError);
      expect(() =>
        resolveProductionMissionOrchestratorRuntime(
          squad,
          {
            id: 'legacy-maestro',
            agentName: 'Legacy Maestro',
            category: 'orchestrator',
            cli: retiredId,
          },
          productionDeps('operator-choice'),
        ),
      ).toThrow(new RegExp(RETIRED_ROSTER_ROUTE_MARKER));
    },
  );

  it('keeps install, Main-owned mission control and authentication as operator-choice preflight facts', () => {
    const orchestrator = {
      id: 'maestro',
      agentName: 'Maestro',
      category: 'orchestrator' as const,
      cli: 'custom-cli',
      model: 'custom-model',
    };

    expect(() =>
      resolveProductionMissionOrchestratorRuntime(
        squad,
        orchestrator,
        productionDeps('operator-choice', { installed: false }),
      ),
    ).toThrow(/não está instalada/i);
    expect(() =>
      resolveProductionMissionOrchestratorRuntime(
        squad,
        orchestrator,
        productionDeps('operator-choice', {
          handoffCapable: true,
          missionControlCapable: false,
        }),
      ),
    ).toThrow(/canal.*Main-owned|controle.*PTY/i);
    expect(() =>
      resolveProductionMissionOrchestratorRuntime(
        squad,
        orchestrator,
        productionDeps('operator-choice', { providerReady: false }),
      ),
    ).toThrow(/sem autenticação pronta/i);
  });

  it('preserves the MCP and native read-only gates in governed mode', () => {
    expect(() =>
      resolveProductionMissionOrchestratorRuntime(
        squad,
        {
          id: 'maestro',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'custom-cli',
          model: 'custom-model',
        },
        productionDeps('governed'),
      ),
    ).toThrow(/Nexus MCP/i);
  });
});
