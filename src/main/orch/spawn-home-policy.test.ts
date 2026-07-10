import { describe, expect, it } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { shouldUseEphemeralHome } from './spawn-home-policy';

function adapter(
  mcpAutoload: boolean,
  ephemeralHome = false,
): Pick<CliPtyAdapter, 'env' | 'quirks'> {
  return {
    env: { static: {}, passthrough: [], ephemeralHome },
    quirks: {
      altScreen: false,
      requiresNoAutoUpdate: false,
      mcpAutoload,
      nexusMcp: mcpAutoload ? 'autoload' : 'none',
    },
  };
}

describe('shouldUseEphemeralHome', () => {
  it('usa HOME efêmero para adapters Claude-like com gate ativo', () => {
    expect(shouldUseEphemeralHome(adapter(true), true)).toBe(true);
  });

  it('preserva HOME real para workers não-Claude mesmo com gate ativo', () => {
    expect(shouldUseEphemeralHome(adapter(false), true)).toBe(false);
  });

  it('honra ephemeralHome apenas em adapters que carregam MCP por arquivo', () => {
    expect(shouldUseEphemeralHome(adapter(true, true), false)).toBe(true);
    expect(shouldUseEphemeralHome(adapter(false, true), false)).toBe(false);
  });
});
