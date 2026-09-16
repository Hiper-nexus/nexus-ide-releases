import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterSchema, hasNexusMcpCapability } from '../../shared/adapter-types';
import type { AdapterInfo, CliPtyAdapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import { isFileAuthAdapter } from '../../shared/file-auth-adapters';
import { PRESET_HARNESSES, RESERVED_HARNESS_IDS } from '../../shared/harness-catalog';
import {
  adapterCapabilityMatrixForAdapter,
  orchestrationEvidenceForAdapter,
  primaryKeyEnvVar,
} from '../../main/adapters/adapter-registry';
import {
  cliInstallRecipeFor,
  describeInstallRecipe,
} from '../../main/adapters/cli-install-recipes';
import {
  availablePermissionModes,
  buildControlArgs,
  defaultPermissionMode,
} from '../../main/adapters/control-args';
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

function devinAdapter(): CliPtyAdapter {
  const parsed = adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'devin'),
  );
  if (parsed.kind !== 'cli-pty') throw new Error('devin must be cli-pty');
  return parsed;
}

function adapterInfo(adapter: CliPtyAdapter, installed: boolean): AdapterInfo {
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

describe('Devin CLI on every CLI/provider surface', () => {
  const adapter = devinAdapter();

  it('is a builtin CLI with its own binary, login and install channel', () => {
    expect(adapter.spawn.initialPrompt).toBe('paste');
    expect(adapter.bin).toBe('devin');
    expect(adapter.auth.method).toBe('oauth');
    expect(adapter.auth.loginCommand).toBe('devin auth login');
    expect(accountLoginCommandFor('devin')).toBe('devin auth login');
    expect(
      resolveCliLoginCommand({
        loginCommand: adapter.auth.loginCommand,
        authMethod: adapter.auth.method,
        interactive: adapter.spawn.interactive,
      }),
    ).toBe('devin auth login');
    // OAuth: não há API key primária para colar — keyEnvVar é null.
    expect(primaryKeyEnvVar(adapter)).toBeNull();
    expect(isFileAuthAdapter('devin')).toBe(true);
    expect(sharedAgentAuthFamily('devin')).toBeNull();
    expect(ALL_MULTI_ACCOUNT_ADAPTER_IDS).toContain('devin');
  });

  it('installs through the official channel on every supported OS', () => {
    expect(cliInstallRecipeFor('devin', 'darwin')?.kind).toBe('script');
    expect(cliInstallRecipeFor('devin', 'linux')?.kind).toBe('script');
    expect(cliInstallRecipeFor('devin', 'win32')?.kind).toBe('powershell-script');
    const recipe = cliInstallRecipeFor('devin', 'darwin');
    expect(recipe).not.toBeNull();
    expect(describeInstallRecipe(recipe!)).toContain(
      'https://cli.devin.ai/install.sh',
    );
  });

  it('is a launchable worker, never a Maestro (no Nexus MCP route)', () => {
    // A injeção de MCP do Nexus é uma união fechada (codex/opencode/kimi/grok);
    // devin declara nexusMcp "none", então não publica rota de orquestração.
    expect(adapter.quirks.nexusMcp).toBe('none');
    expect(adapter.quirks.mcpAutoload).toBe(false);
    expect(canUseNexusMcp(adapter)).toBe(false);
    expect(adapterCapabilityMatrixForAdapter(adapter, 'builtin').launchable).toBe(
      true,
    );
    // Sem layout de HOME claude ⇒ o provider preserva o HOME real.
    expect(
      shouldUseEphemeralHome(adapter, true, { mode: 'hardened' }),
    ).toBe(false);
    expect(isDeclaredOrchestratorAdapter(adapterInfo(adapter, true))).toBe(false);
    expect(isVerifiedOrchestratorAdapter(adapterInfo(adapter, true))).toBe(false);
  });

  it('keeps unattended missions possible through the verified dangerous argv', () => {
    // Doutrina do control-args: sem modo escolhido, adapter com yolo declarado
    // roda full-auto — nunca o diálogo interativo de permissão.
    expect(defaultPermissionMode(adapter)).toBe('yolo');
    expect(availablePermissionModes(adapter)).toEqual([
      'default',
      'auto',
      'smart',
      'bypass',
      'yolo',
    ]);
    expect(buildControlArgs(adapter, {})).toEqual([
      '--permission-mode',
      'dangerous',
    ]);
    expect(buildControlArgs(adapter, { permissionMode: 'smart' })).toEqual([
      '--permission-mode',
      'smart',
    ]);
    // "default" do devin mapeia para o modo interativo de aceite.
    expect(buildControlArgs(adapter, { permissionMode: 'default' })).toEqual([
      '--permission-mode',
      'auto',
    ]);
    expect(adapter.control.effort).toBeUndefined();
  });

  it('ships an ACP preset harness without a wrapper package', () => {
    const preset = PRESET_HARNESSES.find((entry) => entry.id === 'devin');
    expect(preset).toBeDefined();
    // A própria CLI serve ACP por stdio — não há wrapper npm no caminho.
    expect(preset!.command).toBe('devin');
    expect(preset!.args).toEqual(['acp']);
    expect(preset!.tier).toBe('preset');
    expect(preset!.canAutoInstall).toBe(false);
    expect(preset!.installInstructionsUrl).toContain('https://');
    // Entrar no catálogo reserva o id: definição custom não pode se passar por ele.
    expect(RESERVED_HARNESS_IDS).toContain('devin');
  });

  it('appears on Providers CLIs and Login, never on Remotos', () => {
    const missing = providerInfo(adapter, {
      installed: false,
      canAutoInstall: true,
    });
    const connected = providerInfo(adapter, {
      installed: true,
      authStrategy: 'subscription',
    });
    const clis = filterProvidersForTab([missing], 'clis', { showAbsent: true });
    const login = filterProvidersForTab([connected], 'login');
    const remote = filterProvidersForTab([connected], 'remote');
    expect(clis.map((p) => p.adapterId)).toEqual(['devin']);
    expect(isExternalLoginProvider(connected)).toBe(true);
    expect(login.map((p) => p.adapterId)).toEqual(['devin']);
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
          entry.adapterId === 'devin' &&
          entry.intent.kind === 'agent',
      ),
    ).toBe(true);

    const absent = buildPanePickerUnavailable([
      providerInfo(adapter, { installed: false }),
    ]);
    expect(absent.map((row) => row.adapterId)).toEqual(['devin']);

    const candidates = listCustomAgentCliCandidates(
      [info],
      [installed],
      'claude',
    );
    expect(candidates.map((item) => item.id)).toEqual(['devin']);

    const ready = missionRuntimeReadiness([info], [installed]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toContain('devin');
  });

  it('ships a Nexus geometric mark so Providers/+ Agent do not fall back to a letter', () => {
    const logo = path.join(
      process.cwd(),
      'src/renderer/assets/provider-logos/devin.svg',
    );
    expect(fs.existsSync(logo)).toBe(true);
    expect(fs.readFileSync(logo, 'utf8')).toContain('Devin');
  });
});
