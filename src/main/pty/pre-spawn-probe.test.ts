import { describe, expect, it } from 'vitest';
import {
  PreSpawnProbeError,
  assertPreSpawnProbe,
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
