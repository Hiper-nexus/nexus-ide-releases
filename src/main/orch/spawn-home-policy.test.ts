import { describe, expect, it } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import {
  isThirdPartyClaudeFamily,
  requiresSpawnGate,
  shouldUseEphemeralHome,
} from './spawn-home-policy';

function adapter(
  mcpAutoload: boolean,
  ephemeralHome = false,
  staticEnv: Record<string, string> = {},
): Pick<CliPtyAdapter, 'env' | 'quirks'> {
  return {
    env: { static: staticEnv, passthrough: [], ephemeralHome },
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

describe('requiresSpawnGate', () => {
  it('always gates an orchestrator even with open MCP/skill allowlists', () => {
    expect(requiresSpawnGate({
      role: 'orchestrator',
      allowedTools: null,
      allowedSkills: null,
    })).toBe(true);
  });

  it('keeps an ordinary open user pane ungated', () => {
    expect(requiresSpawnGate({
      role: 'user',
      allowedTools: null,
      allowedSkills: null,
    })).toBe(false);
  });
});

describe('isThirdPartyClaudeFamily', () => {
  const GLM_BASE_URL = 'https://api.z.ai/api/anthropic';
  const LONGCAT_BASE_URL = 'https://api.longcat.chat/anthropic';

  it('isola Claude-family apontado para endpoint de terceiro (GLM/LongCat)', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(true, false, { ANTHROPIC_BASE_URL: GLM_BASE_URL })),
    ).toBe(true);
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, { ANTHROPIC_BASE_URL: LONGCAT_BASE_URL }),
      ),
    ).toBe(true);
  });

  it('NÃO isola o Claude de assinatura (sem base URL estático)', () => {
    expect(isThirdPartyClaudeFamily(adapter(true, false, {}))).toBe(false);
  });

  it('NÃO isola CLIs não-Claude mesmo que carreguem um base URL', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(false, false, { ANTHROPIC_BASE_URL: GLM_BASE_URL })),
    ).toBe(false);
  });

  it('ignora base URL vazio', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(true, false, { ANTHROPIC_BASE_URL: '' })),
    ).toBe(false);
  });
});
