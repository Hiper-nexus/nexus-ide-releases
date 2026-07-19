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

const ompAdapter: ProbeAdapterView = {
  kind: 'cli-pty',
  auth: { method: 'oauth' },
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
    resolveOmpBin: async () => ({ binPath: '/usr/local/bin/omp', version: '0.1.0' }),
    ...overrides,
  };
}

describe('probePreSpawn — claude family', () => {
  const withClaude = (overrides: Partial<PreSpawnProbeDeps> = {}) =>
    makeDeps({ getAdapter: () => claudeAdapter, ...overrides });

  it('passes when the native keychain credential is readable', async () => {
    const deps = withClaude({ readActiveClaudeCredential: () => '{"blob":1}' });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });

  it('passes when ~/.claude/.credentials.json carries an access token', async () => {
    const deps = withClaude({ readClaudeCredentialsFile: () => '{"tok":1}' });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });

  it('passes when a vault account exists (pinned path judges it)', async () => {
    const deps = withClaude({ listAccounts: () => [{ id: 'a1' }] });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });

  it('passes when a stored API key exists', async () => {
    const deps = withClaude({ hasStoredKey: () => true });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });

  it('passes when only the oauthAccount email is visible (packaged TCC blind spot)', async () => {
    const deps = withClaude({ claudeOauthEmail: () => 'user@example.com' });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });

  it('fails typed + actionable when nothing exists', async () => {
    const failure = await probePreSpawn('claude', withClaude());
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
    const failure = await probePreSpawn('claude', deps);
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
    expect(await probePreSpawn('codex', deps)).toBeNull();
  });

  it('grok passes with a stored key even without the auth file', async () => {
    const deps = makeDeps({
      getAdapter: () => grokAdapter,
      hasStoredKey: () => true,
    });
    expect(await probePreSpawn('grok', deps)).toBeNull();
  });

  it('codex passes with a vault account (prepareAccountForSpawn judges it)', async () => {
    const deps = makeDeps({
      getAdapter: () => codexAdapter,
      listAccounts: () => [{ id: 'c1' }],
    });
    expect(await probePreSpawn('codex', deps)).toBeNull();
  });

  it('grok fails typed + actionable when nothing exists', async () => {
    const failure = await probePreSpawn(
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

describe('probePreSpawn — omp', () => {
  const withOmp = (overrides: Partial<PreSpawnProbeDeps> = {}) =>
    makeDeps({ getAdapter: () => ompAdapter, ...overrides });

  it('passes when resolveOmpBin resolves', async () => {
    expect(await probePreSpawn('omp', withOmp())).toBeNull();
  });

  it('maps a PATH miss to binary-missing with the brew hint', async () => {
    const deps = withOmp({
      resolveOmpBin: async () => {
        throw new Error(
          'binário "omp" não encontrado no PATH — instale com brew install can1357/tap/omp',
        );
      },
    });
    const failure = await probePreSpawn('omp', deps);
    expect(failure?.code).toBe('binary-missing');
    expect(failure?.adapterId).toBe('omp');
    expect(failure?.hint).toContain('brew install can1357/tap/omp');
  });

  it('ignores version-pin failures (the rpc spawn path reports those better)', async () => {
    const deps = withOmp({
      resolveOmpBin: async () => {
        throw new Error('versão do omp incompatível: encontrado 9.9.9');
      },
    });
    expect(await probePreSpawn('omp', deps)).toBeNull();
  });
});

describe('probePreSpawn — api-key adapters', () => {
  it('glm fails key-missing when no key is stored', async () => {
    const failure = await probePreSpawn(
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
    expect(await probePreSpawn('glm', deps)).toBeNull();
  });

  it('api-provider adapters are treated as api-key routes', async () => {
    const deps = makeDeps({ getAdapter: () => ({ kind: 'api-provider' }) });
    const failure = await probePreSpawn('future-http', deps);
    expect(failure?.code).toBe('key-missing');
  });
});

describe('probePreSpawn — pass-through rules', () => {
  it('unknown adapters (including dumb shell/terminal kinds) pass unjudged', async () => {
    expect(await probePreSpawn('shell', makeDeps())).toBeNull();
    expect(await probePreSpawn('no-such-adapter', makeDeps())).toBeNull();
  });

  it('oauth adapters without a dedicated probe pass unjudged', async () => {
    const deps = makeDeps({
      getAdapter: () => ({ kind: 'cli-pty', auth: { method: 'oauth' } }),
    });
    expect(await probePreSpawn('some-oauth-cli', deps)).toBeNull();
  });

  it('a probe internal failure never blocks the spawn', async () => {
    const deps = makeDeps({
      getAdapter: () => {
        throw new Error('registry exploded');
      },
    });
    expect(await probePreSpawn('claude', deps)).toBeNull();
  });
});

describe('assertPreSpawnProbe', () => {
  it('throws a typed error carrying code / adapterId / hint', async () => {
    const deps = makeDeps({ getAdapter: () => grokAdapter });
    const err = await assertPreSpawnProbe('grok', deps).catch((e) => e);
    expect(err).toBeInstanceOf(PreSpawnProbeError);
    expect(err.code).toBe('missing-credential');
    expect(err.adapterId).toBe('grok');
    expect(err.hint).toBe('Run `grok login`.');
    expect(err.message).toContain('[missing-credential]');
    expect(err.message).toContain('grok');
  });

  it('resolves when the probe passes', async () => {
    await expect(assertPreSpawnProbe('shell', makeDeps())).resolves.toBeUndefined();
  });
});
