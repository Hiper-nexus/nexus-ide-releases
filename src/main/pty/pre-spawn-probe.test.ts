import { describe, expect, it, vi } from 'vitest';
import {
  PreSpawnProbeError,
  assertPreSpawnProbe,
  parseExactOmpModelRef,
  preflightOmpRpcSpawn,
  probePreSpawn,
  type PreSpawnProbeDeps,
  type ProbeAdapterView,
} from './pre-spawn-probe';

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

const ompAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: {
    method: 'oauth',
    loginHint:
      'Use Contas in the OMP · RPC panel or run `omp auth-broker login` to connect any supported provider.',
  },
};

const opencodeAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: {
    method: 'api_key',
    loginHint: 'Run `opencode auth login`.',
  },
  models: { default: 'opencode/big-pickle' },
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
    buildOmpProviderKeyEnv: () => ({}),
    resolveOmpBin: async () => ({ binPath: '/usr/local/bin/omp', version: '0.1.0' }),
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
    expect(failure?.hint).toContain('Configurações › Contas');
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
        'opencode/north-mini-code-free',
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

describe('probePreSpawn — omp', () => {
  const withOmp = (overrides: Partial<PreSpawnProbeDeps> = {}) =>
    makeDeps({
      getAdapter: () => ompAdapter,
      authStrategy: () => 'login-needed',
      ...overrides,
    });

  it('blocks an OMP broker that would open interactive provider login', async () => {
    const resolveOmpBin = vi.fn(async () => ({
      binPath: '/usr/local/bin/omp',
      version: '17.0.4',
    }));
    expect(await runProbe('omp', withOmp({ resolveOmpBin }))).toEqual({
      code: 'missing-credential',
      adapterId: 'omp',
      hint: ompAdapter.auth!.loginHint,
    });
    expect(resolveOmpBin).not.toHaveBeenCalled();
  });

  it('does not treat a stale Nexus OMP account row as broker authentication', async () => {
    expect(
      await runProbe(
        'omp',
        withOmp({ listAccounts: () => [{ id: 'stale-omp' }] }),
      ),
    ).toEqual({
      code: 'missing-credential',
      adapterId: 'omp',
      hint: ompAdapter.auth!.loginHint,
    });
  });

  it('passes when OMP auth and binary are both ready', async () => {
    const seenModels: Array<string | undefined> = [];
    expect(
      await runProbe(
        'omp',
        withOmp({
          authStrategy: (_adapterId, model) => {
            seenModels.push(model);
            return model === 'anthropic/claude-sonnet-4-6'
              ? 'subscription'
              : 'login-needed';
          },
        }),
        'anthropic/claude-sonnet-4-6',
      ),
    ).toBeNull();
    expect(seenModels).toEqual(['anthropic/claude-sonnet-4-6']);
  });

  it('maps a PATH miss to binary-missing with the brew hint', async () => {
    const deps = withOmp({
      authStrategy: () => 'subscription',
      resolveOmpBin: async () => {
        throw new Error(
          'binário "omp" não encontrado no PATH — instale com brew install can1357/tap/omp',
        );
      },
    });
    const failure = await runProbe('omp', deps);
    expect(failure?.code).toBe('binary-missing');
    expect(failure?.adapterId).toBe('omp');
    expect(failure?.hint).toContain('brew install can1357/tap/omp');
  });

  it('leaves version-pin failures to the rpc path for a direct user terminal', async () => {
    const deps = withOmp({
      authStrategy: () => 'subscription',
      resolveOmpBin: async () => {
        throw new Error('versão do omp incompatível: encontrado 9.9.9');
      },
    });
    expect(await runProbe('omp', deps)).toBeNull();
  });

  it('blocks an unclassified OMP broker failure for a governed spawn', async () => {
    const deps = withOmp({
      authStrategy: () => 'subscription',
      resolveOmpBin: async () => {
        throw new Error('versão do omp incompatível: encontrado 9.9.9');
      },
    });
    await expect(
      assertPreSpawnProbe('omp', { deps, failClosed: true }),
    ).rejects.toMatchObject({
      code: 'probe-unavailable',
      adapterId: 'omp',
    });
  });
});

describe('preflightOmpRpcSpawn', () => {
  it('bypasses cached auth and rechecks the authoritative source after the binary probe', async () => {
    const order: string[] = [];
    const cachedAuth = vi.fn(() => 'login-needed' as const);
    const authoritativeAuth = vi.fn(() => {
      order.push('authoritative-auth');
      return 'subscription' as const;
    });
    const deps = makeDeps({
      getAdapter: () => ({
        ...ompAdapter,
        models: { default: 'anthropic/claude-sonnet-4-6' },
      }),
      authStrategy: cachedAuth,
      authoritativeAuthStrategy: authoritativeAuth,
      resolveOmpBin: async () => {
        order.push('binary');
        return { binPath: '/usr/local/bin/omp' };
      },
    });

    await expect(
      preflightOmpRpcSpawn('anthropic/claude-sonnet-4-6', { deps }),
    ).resolves.toMatchObject({
      modelRef: 'anthropic/claude-sonnet-4-6',
    });
    expect(cachedAuth).not.toHaveBeenCalled();
    expect(authoritativeAuth).toHaveBeenCalledTimes(2);
    expect(order.at(-1)).toBe('authoritative-auth');
  });

  it('resolves an omitted model to the exact adapter default', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      getAdapter: () => ({
        ...ompAdapter,
        models: { default: 'anthropic/claude-sonnet-4-6' },
      }),
      authStrategy: (_adapterId, model) => {
        order.push(`auth:${model}`);
        return 'subscription';
      },
      resolveOmpBin: async () => {
        order.push('binary');
        return { binPath: '/usr/local/bin/omp' };
      },
    });
    await expect(preflightOmpRpcSpawn(undefined, { deps })).resolves.toEqual({
      modelRef: 'anthropic/claude-sonnet-4-6',
      model: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      },
      binPath: '/usr/local/bin/omp',
      keyEnv: {},
      credentialScope: {
        modelProvider: 'anthropic',
        source: 'broker',
        authorityProviderId: 'anthropic',
        envNames: ['ANTHROPIC_API_KEY'],
      },
    });
    expect(order[0]).toBe('auth:anthropic/claude-sonnet-4-6');
  });

  it('fails before binary resolution when the selected provider is not authenticated', async () => {
    const resolveOmpBin = vi.fn(async () => ({
      binPath: '/usr/local/bin/omp',
    }));
    const deps = makeDeps({
      getAdapter: () => ({
        ...ompAdapter,
        models: { default: 'anthropic/claude-sonnet-4-6' },
      }),
      authStrategy: (_adapterId, model) =>
        model === 'openai-codex/gpt-5.5'
          ? 'login-needed'
          : 'subscription',
      resolveOmpBin,
    });
    await expect(
      preflightOmpRpcSpawn('openai-codex/gpt-5.5', { deps }),
    ).rejects.toMatchObject({
      code: 'missing-credential',
      adapterId: 'omp',
    });
    expect(resolveOmpBin).not.toHaveBeenCalled();
  });

  it('returns only the selected API-key env and fails if it disappears', async () => {
    const deps = makeDeps({
      getAdapter: () => ({
        ...ompAdapter,
        models: { default: 'zai/glm-5' },
      }),
      authStrategy: () => 'api-key',
      buildOmpProviderKeyEnv: (model): Record<string, string> => {
        if (model !== 'zai/glm-5') return {};
        return {
          ZAI_API_KEY: 'selected-secret',
        };
      },
    });
    const result = await preflightOmpRpcSpawn('zai/glm-5', { deps });
    expect(result.keyEnv).toEqual({
      ZAI_API_KEY: 'selected-secret',
    });
    expect(result.keyEnv).not.toHaveProperty('OPENROUTER_API_KEY');

    await expect(
      preflightOmpRpcSpawn('zai/glm-5', {
        deps: {
          ...deps,
          buildOmpProviderKeyEnv: () => ({}),
        },
      }),
    ).rejects.toMatchObject({
      code: 'key-missing',
      adapterId: 'omp',
    });
  });

  it('rejects malformed or absent model refs fail-closed', async () => {
    expect(() => parseExactOmpModelRef('anthropic')).toThrow(
      /provider\/modelId/,
    );
    await expect(
      preflightOmpRpcSpawn(undefined, {
        deps: makeDeps({ getAdapter: () => ompAdapter }),
      }),
    ).rejects.toThrow(/modelo OMP ausente/i);
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
    expect(failure?.hint).toContain('Providers');
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
      getAdapter: () => ompAdapter,
    });
    await expect(
      assertPreSpawnProbe('omp', { deps, failClosed: true }),
    ).rejects.toMatchObject({
      code: 'probe-unavailable',
      adapterId: 'omp',
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
