import { describe, expect, it } from 'vitest';
import { adapterSchema } from '../../shared/adapter-types';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { primaryKeyEnvVar } from '../../main/adapters/adapter-registry';
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
import { ALL_MULTI_ACCOUNT_ADAPTER_IDS } from '../../renderer/components/settings/multi-account-copy';
import { hasProviderLogo } from '../../renderer/components/ProviderLogo';
import { BUILTIN_ADAPTERS } from './index';

function adapterById(id: string): CliPtyAdapter {
  const parsed = adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === id),
  );
  if (parsed.kind !== 'cli-pty') throw new Error(`${id} must be cli-pty`);
  return parsed;
}

describe('Muse Spark via Claude vs Muse Code CLI (F-599)', () => {
  const native = adapterById('muse');
  const viaClaude = adapterById('muse-claude');

  it('keeps Muse Code on its own binary', () => {
    expect(native.bin).toBe('muse');
    expect(native.spawn.interactive).toEqual(['muse']);
    expect(native.quirks.mcpAutoload).toBe(false);
  });

  it('optional Claude Code path points at Meta Model API, not Anthropic', () => {
    expect(viaClaude.bin).toBe('claude');
    expect(viaClaude.models.default).toBe('muse-spark-1.3');
    expect(viaClaude.env.static?.ANTHROPIC_BASE_URL).toBe('https://api.meta.ai');
    expect(viaClaude.env.static?.ANTHROPIC_MODEL).toBe('muse-spark-1.3');
    expect(viaClaude.env.static?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      'muse-spark-1.3',
    );
    expect(viaClaude.env.static?.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      'muse-spark-1.3',
    );
    expect(viaClaude.env.static?.ENABLE_TOOL_SEARCH).toBe('true');
    expect(viaClaude.auth.method).toBe('api_key');
    expect(accountLoginCommandFor('muse-claude')).toBeNull();
    expect(primaryKeyEnvVar(viaClaude)).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(cliInstallRecipeFor('muse-claude')).toBeNull();
    expect(ALL_MULTI_ACCOUNT_ADAPTER_IDS).toContain('muse-claude');
    expect(hasProviderLogo('muse-claude')).toBe(true);
  });

  it('isolates the Claude-family HOME so Muse Spark does not touch native Anthropic auth', () => {
    expect(viaClaude.quirks.mcpAutoload).toBe(true);
    expect(canUseNexusMcp(viaClaude)).toBe(true);
    expect(isThirdPartyClaudeFamily(viaClaude)).toBe(true);
    expect(
      shouldUseEphemeralHome(viaClaude, true, { mode: 'hardened' }),
    ).toBe(true);
  });

  it('routes muse-claude like the launcher table: Meta host + bearer token', () => {
    const route = getUpstreamProvider('muse-claude');
    expect(route?.baseUrl).toBe('https://api.meta.ai');
    const env = buildProviderRoutingEnv('muse-claude', 'meta-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.meta.ai');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('meta-token');
    expect(env.ANTHROPIC_MODEL).toBe('muse-spark-1.3');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
