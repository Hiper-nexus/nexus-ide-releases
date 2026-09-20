import { describe, expect, it } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import {
  acceptsClaudeMcpCliFlags,
  isThirdPartyClaudeFamily,
  requiresSpawnGate,
  shouldUseEphemeralHome,
  usesClaudeHomeLayout,
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

describe('endpoint oficial da Anthropic não é terceiro', () => {
  // REGRESSÃO: shells, wrappers de CLI e imagens de CI exportam
  // ANTHROPIC_BASE_URL=https://api.anthropic.com. O passthrough copiava isso
  // para o env efetivo e o Claude de assinatura era classificado como plano de
  // terceiro: HOME isolado, sem credencial nativa carregada e sem token
  // injetado — /login no meio da missão, sem nenhum terceiro envolvido.
  const official = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };

  it('não classifica a URL oficial herdada como terceiro', () => {
    expect(isThirdPartyClaudeFamily(adapter(true), official)).toBe(false);
  });

  it('preserva o HOME nativo com a URL oficial herdada no autopiloto', () => {
    expect(
      shouldUseEphemeralHome(adapter(true), true, {
        mode: 'operator-choice',
        effectiveEnv: official,
      }),
    ).toBe(false);
  });

  it('continua isolando endpoint de plano de terceiro', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(true), {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      }),
    ).toBe(true);
  });

  it('trata URL ilegível como terceiro (fail-closed)', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(true), {
        ANTHROPIC_BASE_URL: 'não-é-url',
      }),
    ).toBe(true);
  });
});

describe('shouldUseEphemeralHome', () => {
  it('preserva o HOME nativo do Claude no autopiloto mesmo com gate ativo', () => {
    expect(
      shouldUseEphemeralHome(adapter(true), true, {
        mode: 'operator-choice',
      }),
    ).toBe(false);
  });

  it('usa HOME efêmero para o Claude nativo no modo Hardened', () => {
    expect(
      shouldUseEphemeralHome(adapter(true), true, { mode: 'hardened' }),
    ).toBe(true);
  });

  it('mantém Claude-family de terceiro isolado em ambos os modos', () => {
    const glm = adapter(true, false, {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    });
    expect(shouldUseEphemeralHome(glm, true, { mode: 'operator-choice' })).toBe(
      true,
    );
    expect(shouldUseEphemeralHome(glm, true, { mode: 'hardened' })).toBe(true);
  });

  it('preserva HOME real para workers não-Claude mesmo com gate ativo', () => {
    expect(
      shouldUseEphemeralHome(adapter(false), true, { mode: 'hardened' }),
    ).toBe(false);
  });

  it('honra ephemeralHome apenas em adapters que carregam MCP por arquivo', () => {
    expect(
      shouldUseEphemeralHome(adapter(true, true), false, {
        mode: 'operator-choice',
      }),
    ).toBe(true);
    expect(
      shouldUseEphemeralHome(adapter(false, true), false, {
        mode: 'operator-choice',
      }),
    ).toBe(false);
  });

  it('falha fechado no modo Hardened quando o caller omite a política', () => {
    expect(shouldUseEphemeralHome(adapter(true), true)).toBe(true);
  });

  it('reconhece endpoint Claude-family efetivo resolvido no spawn', () => {
    expect(
      shouldUseEphemeralHome(adapter(true), true, {
        mode: 'operator-choice',
        effectiveEnv: {
          ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
        },
      }),
    ).toBe(true);
  });
});

describe('requiresSpawnGate', () => {
  it('always gates an orchestrator even with open MCP/skill allowlists', () => {
    expect(
      requiresSpawnGate({
        role: 'orchestrator',
        allowedTools: null,
        allowedSkills: null,
      }),
    ).toBe(true);
  });

  it('keeps an ordinary open user pane ungated', () => {
    expect(
      requiresSpawnGate({
        role: 'user',
        allowedTools: null,
        allowedSkills: null,
      }),
    ).toBe(false);
  });
});

describe('isThirdPartyClaudeFamily', () => {
  const GLM_BASE_URL = 'https://api.z.ai/api/anthropic';
  const LONGCAT_BASE_URL = 'https://api.longcat.chat/anthropic';

  it('isola Claude-family apontado para endpoint de terceiro (GLM/LongCat)', () => {
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, { ANTHROPIC_BASE_URL: GLM_BASE_URL }),
      ),
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
      isThirdPartyClaudeFamily(
        adapter(false, false, { ANTHROPIC_BASE_URL: GLM_BASE_URL }),
      ),
    ).toBe(false);
  });

  it('ignora base URL vazio', () => {
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, { ANTHROPIC_BASE_URL: '' }),
      ),
    ).toBe(false);
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, { ANTHROPIC_BASE_URL: '   ' }),
      ),
    ).toBe(false);
  });

  it('considera o ambiente efetivo preparado para o spawn', () => {
    expect(
      isThirdPartyClaudeFamily(adapter(true), {
        ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      }),
    ).toBe(true);
  });

  it('não deixa um ambiente efetivo vazio apagar o endpoint estático', () => {
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        }),
        { ANTHROPIC_BASE_URL: '' },
      ),
    ).toBe(true);
  });
});

describe('OpenClaude is not Claude-layout HOME', () => {
  function openclaudeAdapter(staticEnv: Record<string, string> = {}) {
    return {
      bin: 'openclaude' as const,
      env: { static: staticEnv, passthrough: [], ephemeralHome: false },
      quirks: {
        altScreen: true,
        requiresNoAutoUpdate: false,
        mcpAutoload: true,
        nexusMcp: 'autoload' as const,
      },
    };
  }

  it('never stages a ~/.claude ephemeral overlay for OpenClaude', () => {
    expect(
      shouldUseEphemeralHome(openclaudeAdapter(), true, { mode: 'hardened' }),
    ).toBe(false);
    expect(
      shouldUseEphemeralHome(openclaudeAdapter(), true, {
        mode: 'operator-choice',
      }),
    ).toBe(false);
  });

  it('does not treat OpenClaude as third-party Claude-family isolation', () => {
    expect(
      isThirdPartyClaudeFamily(
        openclaudeAdapter({
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        }),
      ),
    ).toBe(false);
  });
});

describe('isThirdPartyClaudeFamily — lei física do binário (bug E 2026-08-17)', () => {
  // Adapter de usuário com bin 'claude' apontando para endpoint terceiro
  // (deepseek/qwen/sakana…) declarava mcpAutoload:false + nexusMcp:none —
  // o worker nascia SEM o MCP do Nexus e só tinha o bloco NEXUS_HANDOFF.
  // O binário É Claude Code: a família é uma propriedade física, não uma
  // declaração do JSON.
  function claudeBinAdapter(staticEnv: Record<string, string>) {
    return {
      bin: 'claude',
      env: { static: staticEnv, passthrough: [], ephemeralHome: false },
      quirks: {
        altScreen: true,
        requiresNoAutoUpdate: false,
        mcpAutoload: false,
        nexusMcp: 'none',
      },
    };
  }

  it('adapter de usuário com bin claude + endpoint terceiro É família Claude', () => {
    expect(
      isThirdPartyClaudeFamily(
        claudeBinAdapter({
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        }) as never,
      ),
    ).toBe(true);
  });

  it('bin claude sem endpoint terceiro não é isolado (Claude nativo)', () => {
    expect(isThirdPartyClaudeFamily(claudeBinAdapter({}) as never)).toBe(false);
  });

  it('quirks autoload continua valendo sem bin declarado', () => {
    expect(
      isThirdPartyClaudeFamily(
        adapter(true, false, {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        }),
      ),
    ).toBe(true);
  });
});

describe('Claude host detection for durable conversations', () => {
  it.each(['claude', '/opt/bin/claude', 'C:\\tools\\claude.exe'])(
    'recognizes %s even without MCP autoload',
    (bin) => {
      expect(usesClaudeHomeLayout({ ...adapter(false), bin })).toBe(true);
    },
  );
  it.each(['openclaude', '/opt/bin/openclaude', 'C:\\tools\\openclaude.exe'])(
    'keeps %s outside the Claude layout',
    (bin) => {
      expect(usesClaudeHomeLayout({ ...adapter(true), bin })).toBe(false);
    },
  );
  it.each(['muse', '/opt/homebrew/bin/muse', 'kimi', 'grok', 'codex'])(
    'does not treat %s as Claude HOME even with mcpAutoload copied on',
    (bin) => {
      expect(usesClaudeHomeLayout({ ...adapter(true), bin })).toBe(false);
      expect(acceptsClaudeMcpCliFlags({ ...adapter(true), bin })).toBe(false);
    },
  );
  it('OpenClaude still accepts Claude MCP argv on its own home', () => {
    expect(
      acceptsClaudeMcpCliFlags({ ...adapter(true), bin: 'openclaude' }),
    ).toBe(true);
  });
});
