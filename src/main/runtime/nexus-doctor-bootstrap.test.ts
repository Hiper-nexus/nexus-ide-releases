import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  inspectConfiguredNexusReadiness,
  type NexusDoctorOptions,
  type NexusDoctorReport,
} from './nexus-doctor';
import {
  buildDoctorProviderSnapshot,
  configureNexusDoctorRuntime,
  disposeNexusDoctorRuntime,
} from './nexus-doctor-bootstrap';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-test',
  projectId: '11111111-1111-4111-8111-111111111111',
  checkoutId: 'checkout-test',
  rootRealPath: '/workspace',
  identitySource: 'manifest',
});

function provider(overrides: Partial<ProviderSettingsInfo> = {}): ProviderSettingsInfo {
  return {
    adapterId: 'codex',
    label: 'Codex',
    icon: '',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: 'codex',
    defaultModel: 'default',
    models: [],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'subscription',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'openai',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...overrides,
  };
}

function adapter(): CliPtyAdapter {
  return {
    kind: 'cli-pty',
    id: 'codex',
    label: 'Codex',
    version: '1',
    icon: '',
    bin: 'codex',
    detect: 'codex',
    install: { method: 'npm', command: 'npm i codex' },
    auth: { method: 'subscription' },
    spawn: {
      interactive: [],
      headless: [],
      ptyRequired: true,
      resumeArgs: [],
      extraArgs: [],
    },
    env: { static: {}, passthrough: [], ephemeralHome: false },
    models: { flag: '--model', list: [], default: 'default' },
    promptInjection: {
      method: 'stdin',
      trailingNewline: true,
      bracketedPaste: false,
    },
    stateParsing: {
      idle: { type: 'timeout', ms: 1_000 },
      shellIntegration: false,
      exitCodes: {},
    },
    quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false, nexusMcp: 'codex' },
    control: {
      permission: { yolo: [], safe: ['--sandbox', 'read-only'], modes: {}, default: '' },
    },
  };
}

afterEach(() => disposeNexusDoctorRuntime());

describe('Nexus Doctor production bootstrap', () => {
  it('derives read-only capability by exercising the enforced CLI policy', () => {
    const secureReadOnlyArgs = vi.fn(() => ['--sandbox', 'read-only']);
    expect(buildDoctorProviderSnapshot(provider(), {
      getAdapter: () => adapter(),
      secureReadOnlyArgs,
    })).toMatchObject({
      adapterId: 'codex',
      readOnlyCapable: true,
    });
    expect(secureReadOnlyArgs).toHaveBeenCalledWith(adapter(), [], true);
  });

  it('fails the provider capability closed when policy cannot confine it', () => {
    expect(buildDoctorProviderSnapshot(provider(), {
      getAdapter: () => adapter(),
      secureReadOnlyArgs: () => {
        throw new Error('not enforceable');
      },
    }).readOnlyCapable).toBe(false);
  });

  it('wires cached runtime, real context, providers and multi-PC status', () => {
    let captured: NexusDoctorOptions | undefined;
    const expected = { ready: true } as NexusDoctorReport;
    const inspectReadiness = vi.fn((options: NexusDoctorOptions) => {
      captured = options;
      return expected;
    });
    const runtimeManager = {
      open: vi.fn(() => ({ health: { status: 'healthy' } })),
    };
    configureNexusDoctorRuntime(
      {
        runtimeManager: runtimeManager as never,
        multiPc: {
          leaseBackendConfigured: true,
          syncBackendConfigured: true,
          requireSharedExecution: true,
        },
      },
      {
        inspectReadiness,
        inspectContext: () => ({ ready: true, blockers: [], warnings: [], sensorIds: [] }),
        listProviderSettings: () => [provider(), provider({ adapterId: 'shell' })],
        getAdapter: () => adapter(),
        secureReadOnlyArgs: () => [],
      },
    );

    expect(inspectConfiguredNexusReadiness(scope)).toBe(expected);
    expect(captured?.multiPc).toEqual({
      leaseBackendConfigured: true,
      syncBackendConfigured: true,
      requireSharedExecution: true,
    });
    expect(captured?.listProviders?.()).toHaveLength(1);
    captured?.runtime?.openAndInspect(scope);
    expect(runtimeManager.open).toHaveBeenCalledWith(scope);
  });
});
