import { describe, expect, it, vi } from 'vitest';
import {
  PRODUCTION_PROBE_DEPS,
  PreSpawnProbeError,
  assertPreSpawnProbe,
  probePreSpawn,
  type PreSpawnProbeDeps,
  type ProbeAdapterView,
} from './pre-spawn-probe';
import {
  SILENT_REMINT_HINT,
  rememberKimiSeatReadiness,
} from '../adapters/seat-auth-readiness';

const claudeAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: { method: 'oauth', loginHint: 'Run `claude` in a terminal to authenticate.' },
};

const codexAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: { method: 'api_key', loginHint: 'Run `codex login`.' },
};

const grokAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: { method: 'api_key', loginHint: 'Run `grok login`.' },
};

const glmAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: { method: 'api_key' },
};

const opencodeAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: {
    method: 'api_key',
    loginHint: 'Run `opencode auth login`.',
  },
  models: { default: 'opencode/big-pickle' },
};

const agyAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: {
    method: 'oauth',
    loginHint: 'Run `agy` and complete Google OAuth.',
  },
  models: { default: 'gemini-3.6-flash-high' },
};

function makeDeps(overrides: Partial<PreSpawnProbeDeps> = {}): PreSpawnProbeDeps {
  return {
    getAdapter: () => null,
    listAccounts: () => [],
    hasStoredKey: () => false,
    readActiveClaudeCredential: () => null,
    readClaudeCredentialsFile: () => null,
    claudeOauthEmail: () => null,
    hasNativeFileAuth: () => false,
    authStrategy: () => 'subscription',
    ...overrides,
  };
}

function runProbe(
  adapterId: string,
  deps: PreSpawnProbeDeps,
  model?: string,
) {
  return probePreSpawn(adapterId, { deps, model });
}

function runAssert(
  adapterId: string,
  deps: PreSpawnProbeDeps,
  model?: string,
) {
  return assertPreSpawnProbe(adapterId, { deps, model });
}

describe('probePreSpawn — claude family', () => {
  const withClaude = (overrides: Partial<PreSpawnProbeDeps> = {}) =>
    makeDeps({ getAdapter: () => claudeAdapter, ...overrides });

  it('passes when the native keychain credential is readable', async () => {
    const deps = withClaude({
      readActiveClaudeCredential: () =>
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }),
    });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('passes when ~/.claude/.credentials.json carries an access token', async () => {
    const deps = withClaude({ readClaudeCredentialsFile: () => '{"tok":1}' });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('passes when a vault account exists (pinned path judges it)', async () => {
    const deps = withClaude({ listAccounts: () => [{ id: 'a1' }] });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('passes when a stored API key exists', async () => {
    const deps = withClaude({ hasStoredKey: () => true });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('allows email-only for direct (non-governed) terminals — CLI uses native keychain', async () => {
    const deps = withClaude({ claudeOauthEmail: () => 'user@example.com' });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('fail-closed rejects email-only for governed / isolated-home spawns', async () => {
    const deps = withClaude({ claudeOauthEmail: () => 'user@example.com' });
    const failure = await probePreSpawn('claude', {
      deps,
      failClosed: true,
    });
    expect(failure?.code).toBe('missing-credential');
    expect(failure?.adapterId).toBe('claude');
  });

  it('fail-closed passes when keychain blob has usable accessToken', async () => {
    const deps = withClaude({
      readActiveClaudeCredential: () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: 'sk-ant-oat01-live' },
        }),
      claudeOauthEmail: () => 'user@example.com',
    });
    expect(
      await probePreSpawn('claude', { deps, failClosed: true }),
    ).toBeNull();
  });

  it('fail-closed passes when `claude auth status` attests a live session', async () => {
    // Keychain-only session unreadable from the spawn host (packaged-app
    // TCC/ACL denial): storage reads fail but the CLI owns the session.
    const deps = withClaude({
      claudeCliLoggedIn: () => true,
      claudeOauthEmail: () => 'user@example.com',
    });
    expect(
      await probePreSpawn('claude', { deps, failClosed: true }),
    ).toBeNull();
  });

  it('fail-closed still blocks when CLI attestation is negative', async () => {
    const deps = withClaude({
      claudeCliLoggedIn: () => false,
      claudeOauthEmail: () => 'user@example.com',
    });
    const failure = await probePreSpawn('claude', {
      deps,
      failClosed: true,
    });
    expect(failure?.code).toBe('missing-credential');
    expect(failure?.adapterId).toBe('claude');
  });

  it('fails typed + actionable when nothing exists', async () => {
    const failure = await runProbe('claude', withClaude());
    expect(failure).toEqual({
      code: 'missing-credential',
      adapterId: 'claude',
      hint: 'Run `claude` in a terminal to authenticate.',
    });
  });

  it('falls back to a panel hint when the adapter declares no loginHint', async () => {
    const deps = makeDeps({
      getAdapter: () => ({ kind: 'cli-pty', auth: { method: 'oauth' } }),
    });
    const failure = await runProbe('claude', deps);
    expect(failure?.code).toBe('missing-credential');
    expect(failure?.hint).toContain('Configurações › Contas de IA');
  });
});

describe('probePreSpawn — file-backed adapters', () => {
  it('codex passes with a native auth file', async () => {
    const deps = makeDeps({
      getAdapter: () => codexAdapter,
      hasNativeFileAuth: () => true,
    });
    expect(await runProbe('codex', deps)).toBeNull();
  });

  it('grok passes with a stored key even without the auth file', async () => {
    const deps = makeDeps({
      getAdapter: () => grokAdapter,
      hasStoredKey: () => true,
    });
    expect(await runProbe('grok', deps)).toBeNull();
  });

  it('codex passes with a vault account (prepareAccountForSpawn judges it)', async () => {
    const deps = makeDeps({
      getAdapter: () => codexAdapter,
      listAccounts: () => [{ id: 'c1' }],
    });
    expect(await runProbe('codex', deps)).toBeNull();
  });

  it('grok fails typed + actionable when nothing exists', async () => {
    const failure = await runProbe(
      'grok',
      makeDeps({ getAdapter: () => grokAdapter }),
    );
    expect(failure).toEqual({
      code: 'missing-credential',
      adapterId: 'grok',
      hint: 'Run `grok login`.',
    });
  });

  it('accepts AGY keychain-only auth without inventing a required OAuth file', async () => {
    const authoritativeAuth = vi.fn(() => 'subscription' as const);
    const deps = makeDeps({
      getAdapter: () => agyAdapter,
      authStrategy: () => 'subscription',
      authoritativeAuthStrategy: authoritativeAuth,
      hasNativeFileAuth: () => false,
    });

    expect(
      await probePreSpawn('agy', {
        deps,
        failClosed: true,
      }),
    ).toBeNull();
    expect(authoritativeAuth).toHaveBeenCalledOnce();
  });

  it('accepts AGY keychain auth from the authoritative spawn decision when the UI cache is stale', async () => {
    const cachedAuth = vi.fn(() => 'login-needed' as const);
    const authoritativeAuth = vi.fn(async () => 'subscription' as const);
    const deps = makeDeps({
      getAdapter: () => agyAdapter,
      authStrategy: cachedAuth,
      authoritativeAuthStrategy: authoritativeAuth,
      hasNativeFileAuth: () => false,
    });

    expect(
      await probePreSpawn('agy', {
        deps,
        model: 'gemini-3.6-flash-high',
        failClosed: true,
      }),
    ).toBeNull();
    expect(authoritativeAuth).toHaveBeenCalledWith(
      'agy',
      'gemini-3.6-flash-high',
    );
    expect(cachedAuth).not.toHaveBeenCalled();
  });

  it('rejects AGY when the authoritative spawn decision observes logout despite a ready UI cache', async () => {
    const deps = makeDeps({
      getAdapter: () => agyAdapter,
      authStrategy: () => 'subscription',
      authoritativeAuthStrategy: () => 'login-needed',
      hasNativeFileAuth: () => false,
    });

    const failure = await probePreSpawn('agy', {
      deps,
      failClosed: true,
    });
    expect(failure).toEqual({
      code: 'missing-credential',
      adapterId: 'agy',
      hint: 'Run `agy` and complete Google OAuth.',
    });
  });
});

describe('probePreSpawn — credentialless OpenCode', () => {
  const withOpenCode = (overrides: Partial<PreSpawnProbeDeps> = {}) =>
    makeDeps({
      getAdapter: () => opencodeAdapter,
      authStrategy: () => 'login-needed',
      ...overrides,
    });

  it('uses the pinned builtin default without requiring a credential', async () => {
    expect(await runProbe('opencode', withOpenCode())).toBeNull();
  });

  it('passes an exact selected first-party free model', async () => {
    expect(
      await runProbe(
        'opencode',
        withOpenCode(),
        'opencode/nemotron-3-ultra-free',
      ),
    ).toBeNull();
  });

  it.each([
    'openrouter/openai/gpt-5',
    'opencode/unreviewed-free',
    'other/opencode/big-pickle',
  ])('rejects unauthenticated model %s', async (model) => {
    const failure = await runProbe('opencode', withOpenCode(), model);
    expect(failure).toEqual({
      code: 'missing-credential',
      adapterId: 'opencode',
      hint: 'Run `opencode auth login`.',
    });
  });

  it('still accepts external models when native auth exists', async () => {
    expect(
      await runProbe(
        'opencode',
        withOpenCode({
          authStrategy: () => 'subscription',
          hasNativeFileAuth: () => true,
        }),
        'openrouter/openai/gpt-5',
      ),
    ).toBeNull();
  });
});

describe('probePreSpawn — api-key adapters', () => {
  it('glm fails key-missing when no key is stored', async () => {
    const failure = await runProbe(
      'glm',
      makeDeps({ getAdapter: () => glmAdapter }),
    );
    expect(failure?.code).toBe('key-missing');
    expect(failure?.adapterId).toBe('glm');
    expect(failure?.hint).toContain('Contas de IA');
  });

  it('glm passes with a stored key', async () => {
    const deps = makeDeps({
      getAdapter: () => glmAdapter,
      hasStoredKey: () => true,
    });
    expect(await runProbe('glm', deps)).toBeNull();
  });

  it('api-provider adapters are treated as api-key routes', async () => {
    const deps = makeDeps({ getAdapter: () => ({ kind: 'api-provider' }) });
    const failure = await runProbe('future-http', deps);
    expect(failure?.code).toBe('key-missing');
  });

  it('autopilot remint de LongCat não tosta Cole sua API key', async () => {
    const longcat: ProbeAdapterView = {
      kind: 'cli-pty',
      auth: {
        method: 'api_key',
        loginHint: 'Cole sua API key do LongCat em Configurações › Contas de IA',
      },
    };
    const failure = await probePreSpawn('longcat', {
      deps: makeDeps({ getAdapter: () => longcat }),
      silentRemint: true,
    });
    expect(failure?.code).toBe('missing-credential');
    expect(failure?.hint).toBe(SILENT_REMINT_HINT);
    expect(failure?.hint).not.toMatch(/cole sua api key/i);
  });
});

describe('probePreSpawn — kimi 5-state seating', () => {
  const kimiAdapter: ProbeAdapterView = {
    kind: 'cli-pty',
    auth: { method: 'oauth', loginHint: 'rode `kimi login`' },
  };

  it('arquivo OAuth sem provider list não senta (incomplete)', async () => {
    const failure = await runProbe(
      'kimi',
      makeDeps({
        getAdapter: () => kimiAdapter,
        hasNativeFileAuth: () => true,
        authStrategy: () => 'subscription',
      }),
    );
    expect(failure?.code).toBe('missing-credential');
    expect(failure?.adapterId).toBe('kimi');
  });

  it('source=oauth no provider list senta', async () => {
    expect(
      await runProbe(
        'kimi',
        makeDeps({
          getAdapter: () => kimiAdapter,
          authStrategy: () => 'subscription',
          kimiSeatReadiness: () => 'present',
        }),
      ),
    ).toBeNull();
  });

  it('disabled / missing / unreadable não sentam', async () => {
    for (const state of ['no-credential', 'missing', 'unreadable'] as const) {
      const failure = await runProbe(
        'kimi',
        makeDeps({
          getAdapter: () => kimiAdapter,
          authStrategy: () => 'subscription',
          kimiSeatReadiness: () => state,
        }),
      );
      expect(failure?.code).toBe('missing-credential');
    }
  });

  it('a fiação de produção sonda o provider list ao vivo, não a cache', () => {
    // Campo 10/09: a cache de processo era o ÚNICO insumo do spawn. Ela é
    // aquecida em Settings/Contas, kickoff e bootstrap — nunca no spawn direto
    // do operador —, então uma cache fria condenava o assento e o pane subia
    // como claude sem aviso ("pedi kimi, abriu sonnet").
    expect(typeof PRODUCTION_PROBE_DEPS.kimiSeatReadiness).toBe('function');
  });

  it('cache envenenada não sobrevive à sonda viva', async () => {
    rememberKimiSeatReadiness('missing');
    try {
      // Sem sonda (fiação antiga) a cache manda: o assento se perde.
      expect(
        (
          await runProbe(
            'kimi',
            makeDeps({
              getAdapter: () => kimiAdapter,
              authStrategy: () => 'subscription',
            }),
          )
        )?.code,
      ).toBe('missing-credential');

      // Com a sonda viva respondendo, o mesmo spawn senta.
      expect(
        await runProbe(
          'kimi',
          makeDeps({
            getAdapter: () => kimiAdapter,
            authStrategy: () => 'subscription',
            kimiSeatReadiness: () => 'present',
          }),
        ),
      ).toBeNull();
    } finally {
      rememberKimiSeatReadiness(undefined);
    }
  });
});

describe('probePreSpawn — pass-through rules', () => {
  it('unknown adapters (including dumb shell/terminal kinds) pass unjudged', async () => {
    expect(await runProbe('shell', makeDeps())).toBeNull();
    expect(await runProbe('no-such-adapter', makeDeps())).toBeNull();
  });

  it('oauth adapters without a dedicated probe pass unjudged', async () => {
    const deps = makeDeps({
      getAdapter: () => ({ kind: 'cli-pty', auth: { method: 'oauth' } }),
    });
    expect(await runProbe('some-oauth-cli', deps)).toBeNull();
  });

  it('a probe internal failure stays unjudged for a direct user spawn', async () => {
    const deps = makeDeps({
      getAdapter: () => {
        throw new Error('registry exploded');
      },
    });
    expect(await runProbe('claude', deps)).toBeNull();
  });

  it('a probe internal failure blocks a governed spawn', async () => {
    const deps = makeDeps({
      authStrategy: () => {
        throw new Error('readiness store unavailable');
      },
      getAdapter: () => claudeAdapter,
    });
    await expect(
      assertPreSpawnProbe('claude', { deps, failClosed: true }),
    ).rejects.toMatchObject({
      code: 'probe-unavailable',
      adapterId: 'claude',
      hint: expect.stringMatching(/comprovar.*prontidão/i),
    });
  });
});

describe('assertPreSpawnProbe', () => {
  it('throws a typed error carrying code / adapterId / hint', async () => {
    const deps = makeDeps({ getAdapter: () => grokAdapter });
    const err = await runAssert('grok', deps).catch((e) => e);
    expect(err).toBeInstanceOf(PreSpawnProbeError);
    expect(err.code).toBe('missing-credential');
    expect(err.adapterId).toBe('grok');
    expect(err.hint).toBe('Run `grok login`.');
    expect(err.message).toContain('[missing-credential]');
    expect(err.message).toContain('grok');
  });

  it('resolves when the probe passes', async () => {
    await expect(runAssert('shell', makeDeps())).resolves.toBeUndefined();
  });
});
