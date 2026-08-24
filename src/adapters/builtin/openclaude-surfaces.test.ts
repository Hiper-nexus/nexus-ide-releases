import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterSchema, hasNexusMcpCapability } from '../../shared/adapter-types';
import type { AdapterInfo, CliPtyAdapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import {
  adapterCapabilityMatrixForAdapter,
  orchestrationEvidenceForAdapter,
  primaryKeyEnvVar,
} from '../../main/adapters/adapter-registry';
import { cliInstallRecipeFor } from '../../main/adapters/cli-install-recipes';
import { canUseNexusMcp } from '../../main/orch/cli-mcp-inject';
import { shouldUseEphemeralHome } from '../../main/orch/spawn-home-policy';
import {
  filterProvidersForTab,
  isExternalLoginProvider,
  providerRowCta,
  providerStatusLabel,
} from '../../renderer/components/settings/providers-panel-view';
import { ALL_MULTI_ACCOUNT_ADAPTER_IDS } from '../../renderer/components/settings/multi-account-copy';
import {
  buildPanePickerEntries,
  buildPanePickerUnavailable,
} from '../../renderer/components/PanePicker';
import { listCustomAgentCliCandidates } from '../../renderer/orch/mission-roster-customize';
import { missionRuntimeReadiness } from '../../renderer/orch/mission-runtime-readiness';
import {
  isDeclaredOrchestratorAdapter,
  isVerifiedOrchestratorAdapter,
} from '../../renderer/orch/orchestrator-runtime';
import { BUILTIN_ADAPTERS } from './index';

function openclaudeAdapter(): CliPtyAdapter {
  const parsed = adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'openclaude'),
  );
  if (parsed.kind !== 'cli-pty') throw new Error('openclaude must be cli-pty');
  return parsed;
}

function adapterInfo(
  adapter: CliPtyAdapter,
  installed: boolean,
): AdapterInfo {
  const capabilities = adapterCapabilityMatrixForAdapter(adapter, 'builtin');
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label,
    icon: adapter.icon,
    models: adapter.models,
    installed,
    installCommand: adapter.install.command,
    loginHint: adapter.auth.loginHint,
    idleTimeoutMs: 800,
    orchestratorCapable: hasNexusMcpCapability(adapter.quirks),
    orchestrationEvidence: orchestrationEvidenceForAdapter(adapter, 'builtin'),
    capabilities,
    taskHandoffCapable: true,
    missionControlCapable: true,
  };
}

function providerInfo(
  adapter: CliPtyAdapter,
  overrides: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  const loginCommand =
    resolveCliLoginCommand({
      loginCommand: adapter.auth.loginCommand,
      authMethod: adapter.auth.method,
      interactive: adapter.spawn.interactive,
    }) ?? undefined;
  return {
    adapterId: adapter.id,
    label: adapter.label,
    icon: adapter.icon,
    kind: adapter.kind,
    enabled: true,
    installed: true,
    canAutoInstall: cliInstallRecipeFor(adapter.id) !== null,
    binPath: '',
    detectedBin: adapter.bin,
    defaultModel: adapter.models.default,
    models: adapter.models.list,
    authReadyModels: adapter.models.list,
    extraArgs: [],
    keyEnvVar: primaryKeyEnvVar(adapter),
    hasKey: false,
    keyMasked: null,
    authMethod: adapter.auth.method,
    loginHint: adapter.auth.loginHint,
    loginCommand,
    secureStorageAvailable: true,
    authStrategy: 'login-needed',
    upstream: 'anthropic',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: adapter.control.effort?.levels ?? [],
    verbose: false,
    supportsVerbose: Boolean(adapter.control.verbose),
    customModels: [],
    ...overrides,
  };
}

describe('OpenClaude on every CLI/provider surface', () => {
  const adapter = openclaudeAdapter();

  it('is a builtin CLI with its own binary, login and install channel', () => {
    expect(adapter.bin).toBe('openclaude');
    expect(adapter.auth.loginCommand).toBe('openclaude auth login');
    expect(accountLoginCommandFor('openclaude')).toBe('openclaude auth login');
    expect(
      resolveCliLoginCommand({
        loginCommand: adapter.auth.loginCommand,
        authMethod: adapter.auth.method,
        interactive: adapter.spawn.interactive,
      }),
    ).toBe('openclaude auth login');
    expect(cliInstallRecipeFor('openclaude', 'darwin')?.kind).toBe('argv');
    expect(primaryKeyEnvVar(adapter)).toBe('OPENAI_API_KEY');
    expect(canUseNexusMcp(adapter)).toBe(true);
    expect(
      shouldUseEphemeralHome(adapter, true, { mode: 'hardened' }),
    ).toBe(false);
    expect(sharedAgentAuthFamily('openclaude')).toBeNull();
    expect(ALL_MULTI_ACCOUNT_ADAPTER_IDS).toContain('openclaude');
  });

  it('appears on Providers CLIs and Login, never on Remotos', () => {
    const missing = providerInfo(adapter, { installed: false });
    const connected = providerInfo(adapter, {
      installed: true,
      authStrategy: 'subscription',
    });
    const clis = filterProvidersForTab([missing], 'clis', { showAbsent: true });
    const login = filterProvidersForTab([connected], 'login');
    const remote = filterProvidersForTab([connected], 'remote');
    expect(clis.map((p) => p.adapterId)).toEqual(['openclaude']);
    expect(isExternalLoginProvider(connected)).toBe(true);
    expect(login.map((p) => p.adapterId)).toEqual(['openclaude']);
    expect(remote).toEqual([]);
  });

  it('offers Instalar when absent and Entrar when the CLI needs login', () => {
    const missing = providerInfo(adapter, {
      installed: false,
      canAutoInstall: true,
    });
    const needsLogin = providerInfo(adapter, {
      installed: true,
      authStrategy: 'login-needed',
    });
    expect(providerStatusLabel(missing)).toEqual({
      label: 'não instalada',
      tone: 'warn',
    });
    expect(providerRowCta(missing)).toEqual({
      kind: 'install',
      label: 'Instalar',
    });
    expect(providerStatusLabel(needsLogin)).toEqual({
      label: 'precisa login',
      tone: 'warn',
    });
    expect(providerRowCta(needsLogin)).toEqual({
      kind: 'login',
      label: 'Entrar',
    });
  });

  it('is pickable from + Agent, Iniciar Ferramenta and Maestro picker', () => {
    const installed = providerInfo(adapter);
    const info = adapterInfo(adapter, true);
    const entries = buildPanePickerEntries([installed], []);
    expect(
      entries.some(
        (entry) =>
          entry.section === 'clis' &&
          entry.adapterId === 'openclaude' &&
          entry.intent.kind === 'agent',
      ),
    ).toBe(true);

    const absent = buildPanePickerUnavailable([
      providerInfo(adapter, { installed: false }),
    ]);
    expect(absent.map((row) => row.adapterId)).toEqual(['openclaude']);

    const candidates = listCustomAgentCliCandidates(
      [info],
      [installed],
      'claude',
    );
    expect(candidates.map((item) => item.id)).toEqual(['openclaude']);

    const ready = missionRuntimeReadiness([info], [installed]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toContain(
      'openclaude',
    );
    expect(isDeclaredOrchestratorAdapter(info)).toBe(true);
    expect(isVerifiedOrchestratorAdapter(info)).toBe(false);
  });

  it('ships a Nexus geometric mark so Providers/+ Agent do not fall back to a letter', () => {
    const logo = path.join(
      process.cwd(),
      'src/renderer/assets/provider-logos/openclaude.svg',
    );
    expect(fs.existsSync(logo)).toBe(true);
    expect(fs.readFileSync(logo, 'utf8')).toContain('OpenClaude');
  });
});
