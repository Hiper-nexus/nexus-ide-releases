import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterSchema, hasNexusMcpCapability } from '../../shared/adapter-types';
import type { AdapterInfo, CliPtyAdapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import {
  adapterCapabilityMatrixForAdapter,
  orchestrationEvidenceForAdapter,
  primaryKeyEnvVar,
} from '../../main/adapters/adapter-registry';
import { cliInstallRecipeFor } from '../../main/adapters/cli-install-recipes';
import {
  buildProviderRoutingEnv,
  getUpstreamProvider,
} from '../../main/adapters/launcher-provider-manager';
import { canUseNexusMcp } from '../../main/orch/cli-mcp-inject';
import {
  isThirdPartyClaudeFamily,
  shouldUseEphemeralHome,
} from '../../main/orch/spawn-home-policy';
import {
  filterProvidersForTab,
  isExternalLoginProvider,
  providerRowCta,
  providerStatusLabel,
} from '../../renderer/components/settings/providers-panel-view';
import { ALL_MULTI_ACCOUNT_ADAPTER_IDS } from '../../renderer/components/settings/multi-account-copy';
import { hasProviderLogo } from '../../renderer/components/ProviderLogo';
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

function glmFlashAdapter(): CliPtyAdapter {
  const parsed = adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'glm-flash'),
  );
  if (parsed.kind !== 'cli-pty') throw new Error('glm-flash must be cli-pty');
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
    loginCommand: undefined,
    secureStorageAvailable: true,
    authStrategy: 'login-needed',
    upstream: 'glm-flash',
    routable: true,
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

describe('GLM Flash (`ai gf`) on every CLI/provider surface', () => {
  const adapter = glmFlashAdapter();

  it('is the launcher glm-flash session: claude bin on z.ai, every slot on Flash', () => {
    expect(adapter.id).toBe('glm-flash');
    expect(adapter.bin).toBe('claude');
    expect(adapter.models.default).toBe('glm-5.3-flash[1m]');
    expect(adapter.models.list).toContain('glm-5.3-flash[1m]');
    const env = adapter.env.static;
    // glm_flash_setup_env: provider glm + TODOS os slots no Flash.
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env?.ANTHROPIC_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3-flash[1m]');
    // A rota upstream própria produz o mesmo conjunto (parity de --via).
    const route = getUpstreamProvider('glm-flash');
    expect(route?.baseUrl).toBe(env?.ANTHROPIC_BASE_URL);
    const routed = buildProviderRoutingEnv('glm-flash', 'tok');
    for (const key of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]) {
      expect(routed[key]).toBe(env?.[key]);
    }
  });

  it('is key-only like glm: no login command, token via ANTHROPIC_AUTH_TOKEN', () => {
    expect(adapter.auth.method).toBe('api_key');
    expect(accountLoginCommandFor('glm-flash')).toBeNull();
    expect(primaryKeyEnvVar(adapter)).toBe('ANTHROPIC_AUTH_TOKEN');
    // Como glm/longcat: sem CLI própria a instalar (roda o bin `claude`) —
    // nenhuma receita inventada; o adapter detecta `claude --version`.
    expect(cliInstallRecipeFor('glm-flash')).toBeNull();
    expect(sharedAgentAuthFamily('glm-flash')).toBeNull();
    expect(ALL_MULTI_ACCOUNT_ADAPTER_IDS).toContain('glm-flash');
  });

  it('keeps Nexus MCP and the third-party Claude isolated home', () => {
    expect(adapter.quirks.mcpAutoload).toBe(true);
    expect(canUseNexusMcp(adapter)).toBe(true);
    // bin claude + BASE_URL terceiro → nunca o ~/.claude da assinatura.
    expect(isThirdPartyClaudeFamily(adapter)).toBe(true);
    expect(
      shouldUseEphemeralHome(adapter, true, { mode: 'hardened' }),
    ).toBe(true);
  });

  it('appears on Providers CLIs and Login (when the key is missing), never on Remotos', () => {
    const missing = providerInfo(adapter, { installed: false });
    const needsKey = providerInfo(adapter, { authStrategy: 'login-needed' });
    const connected = providerInfo(adapter, { authStrategy: 'api-key' });
    const clis = filterProvidersForTab([missing], 'clis', { showAbsent: true });
    const login = filterProvidersForTab([needsKey], 'login');
    const remote = filterProvidersForTab([connected], 'remote');
    expect(clis.map((p) => p.adapterId)).toEqual(['glm-flash']);
    expect(isExternalLoginProvider(needsKey)).toBe(true);
    expect(login.map((p) => p.adapterId)).toEqual(['glm-flash']);
    expect(remote).toEqual([]);
  });

  it('shows "não instalada" without an install CTA and Colar chave when the token is missing', () => {
    const missing = providerInfo(adapter, {
      installed: false,
      canAutoInstall: false,
    });
    const needsKey = providerInfo(adapter, { authStrategy: 'login-needed' });
    expect(providerStatusLabel(missing)).toEqual({
      label: 'não instalada',
      tone: 'warn',
    });
    // Sem canal de install próprio (bin claude) — o CTA de instalação não
    // aparece; a presença segue o adapter `claude`/`claude --version`.
    expect(providerRowCta(missing)).toBeNull();
    expect(providerStatusLabel(needsKey)).toEqual({
      label: 'precisa login',
      tone: 'warn',
    });
    expect(providerRowCta(needsKey)).toEqual({
      kind: 'key',
      label: 'Colar chave',
    });
  });

  it('is pickable from + Pane, squad roster and mission workers', () => {
    const installed = providerInfo(adapter);
    const info = adapterInfo(adapter, true);
    const entries = buildPanePickerEntries([installed], []);
    expect(
      entries.some(
        (entry) =>
          entry.section === 'clis' &&
          entry.adapterId === 'glm-flash' &&
          entry.intent.kind === 'agent',
      ),
    ).toBe(true);

    const absent = buildPanePickerUnavailable([
      providerInfo(adapter, { installed: false }),
    ]);
    expect(absent.map((row) => row.adapterId)).toEqual(['glm-flash']);

    const candidates = listCustomAgentCliCandidates(
      [info],
      [installed],
      'claude',
    );
    expect(candidates.map((item) => item.id)).toEqual(['glm-flash']);

    const ready = missionRuntimeReadiness([info], [installed]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toContain(
      'glm-flash',
    );
    expect(isDeclaredOrchestratorAdapter(info)).toBe(true);
    expect(isVerifiedOrchestratorAdapter(info)).toBe(false);
  });

  it('reuses the GLM geometric mark on Providers/+ Pane', () => {
    expect(hasProviderLogo('glm-flash')).toBe(true);
    const logo = path.join(
      process.cwd(),
      'src/renderer/assets/provider-logos/glm.svg',
    );
    expect(fs.existsSync(logo)).toBe(true);
  });
});
