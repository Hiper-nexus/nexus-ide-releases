import { describe, expect, it } from 'vitest';
import { adapterSchema } from '../../shared/adapter-types';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { canUseNexusMcp } from '../../main/orch/cli-mcp-inject';
import { shouldUseEphemeralHome } from '../../main/orch/spawn-home-policy';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { BUILTIN_ADAPTERS } from './index';

function museAdapter(): CliPtyAdapter {
  const parsed = adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'muse'),
  );
  if (parsed.kind !== 'cli-pty') throw new Error('muse must be cli-pty');
  return parsed;
}

describe('Muse CLI spawn contract (F-596)', () => {
  const adapter = museAdapter();

  it('is a builtin CLI with its own binary and login, not the Claude family', () => {
    expect(adapter.bin).toBe('muse');
    expect(adapter.auth.loginCommand).toBe('muse login');
    expect(accountLoginCommandFor('muse')).toBe('muse login');
    expect(
      resolveCliLoginCommand({
        loginCommand: adapter.auth.loginCommand,
        authMethod: adapter.auth.method,
        interactive: adapter.spawn.interactive,
      }),
    ).toBe('muse login');
  });

  it('does not claim Claude --mcp-config autoload (unknown flags dump --help and exit 2)', () => {
    expect(adapter.quirks.mcpAutoload).toBe(false);
    // F-696: o MCP do Nexus chega pelo settings.json do Muse 1.4+ (ponte
    // stdio + ENV), nunca por flag do Claude no argv.
    expect(adapter.quirks.nexusMcp).toBe('muse');
    expect(canUseNexusMcp(adapter)).toBe(true);
    expect(
      shouldUseEphemeralHome(adapter, true, { mode: 'hardened' }),
    ).toBe(false);
  });

  it('trusts the workspace for the pane run so Muse does not stall on first-run trust', () => {
    expect(adapter.spawn.extraArgs).toEqual(['--trust-workspace']);
  });

  it('catalogs Muse Spark 1.3, not the adapter placeholder "muse"', () => {
    expect(adapter.models.default).toBe('muse-spark-1.3');
    expect(adapter.models.list).toEqual(['muse-spark-1.3', 'muse-spark-1.2']);
    expect(adapter.models.flag).toBe('--model');
  });
});
