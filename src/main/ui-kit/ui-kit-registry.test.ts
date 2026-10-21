import { describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  assertRegistries,
  buildScopedRegistryEnv,
  envVarReferences,
  projectRegistryUrls,
  assertRegistryNamespace,
  assertRegistryUrl,
  buildRegistryEnv,
  mergeRegistriesIntoComponentsJson,
  registryEntryNeedsAuth,
  registrySecretKey,
  resolveRegistryAuthContract,
  renderRegistryEntry,
  resolveRegistryToken,
  type UiKitRegistry,
} from './ui-kit-registry';

const PRIVATE: UiKitRegistry = {
  namespace: '@acme',
  url: 'https://registry.acme.test/r/{name}.json',
  auth: { kind: 'header', name: 'Authorization', envVar: 'ACME_REGISTRY_TOKEN' },
  secretKey: 'external:ui-kit-registry-acme',
};

describe('assertRegistryNamespace', () => {
  it('accepts a namespace and refuses anything else', () => {
    expect(assertRegistryNamespace('@acme')).toBe('@acme');
    for (const bad of ['acme', '@', '@Acme/x', '@a b', '']) {
      expect(() => assertRegistryNamespace(bad)).toThrow(UiKitCliError);
    }
  });
});

describe('assertRegistryUrl', () => {
  it('requires https and the {name} placeholder', () => {
    expect(assertRegistryUrl('https://r.test/{name}.json')).toBe('https://r.test/{name}.json');
    expect(() => assertRegistryUrl('http://r.test/{name}.json')).toThrow(/must be https/);
    expect(() => assertRegistryUrl('https://r.test/button.json')).toThrow(/\{name\} placeholder/);
  });

  it('refuses credentials embedded in the URL', () => {
    // Those would be written into components.json in clear text.
    expect(() => assertRegistryUrl('https://user:pw@r.test/{name}.json')).toThrow(
      /may not carry a username or password/,
    );
  });
});

describe('renderRegistryEntry', () => {
  it('renders a keyless registry as a bare URL', () => {
    expect(
      renderRegistryEntry({ namespace: '@public', url: 'https://r.test/{name}.json' }),
    ).toBe('https://r.test/{name}.json');
  });

  it('renders a bearer header with the variable NAME, never a value', () => {
    expect(renderRegistryEntry(PRIVATE)).toEqual({
      url: 'https://registry.acme.test/r/{name}.json',
      headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
    });
  });

  it('renders a raw header and a query param', () => {
    expect(
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'header', name: 'X-Api-Key', envVar: 'ACME_API_KEY', scheme: 'raw' },
      }),
    ).toEqual({
      url: PRIVATE.url,
      headers: { 'X-Api-Key': '${ACME_API_KEY}' },
    });

    expect(
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'param', name: 'token', envVar: 'ACME_ACCESS_TOKEN' },
      }),
    ).toEqual({
      url: PRIVATE.url,
      params: { token: '${ACME_ACCESS_TOKEN}' },
    });
  });

  it('refuses a malformed header name or env var', () => {
    expect(() =>
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'header', name: 'Bad Header', envVar: 'T_TOKEN' },
      }),
    ).toThrow(/header name must match/);
    expect(() =>
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'header', name: 'Authorization', envVar: 'lower_token' },
      }),
    ).toThrow(/UPPER_SNAKE_CASE/);
  });
});

describe('mergeRegistriesIntoComponentsJson', () => {
  it('adds registries without touching the rest of the file', () => {
    const existing = { style: 'new-york', aliases: { ui: '@/components/ui' } };

    const merged = mergeRegistriesIntoComponentsJson(existing, [PRIVATE]);

    expect(merged.style).toBe('new-york');
    expect(merged.aliases).toEqual({ ui: '@/components/ui' });
    expect(merged.registries).toEqual({
      '@acme': {
        url: PRIVATE.url,
        headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
      },
    });
  });

  it('keeps a namespace Nexus does not manage', () => {
    const existing = { registries: { '@theirs': 'https://theirs.test/{name}.json' } };

    const merged = mergeRegistriesIntoComponentsJson(existing, [PRIVATE]);

    expect((merged.registries as Record<string, unknown>)['@theirs']).toBe(
      'https://theirs.test/{name}.json',
    );
  });

  it('does not mutate the object it was given', () => {
    const existing = { registries: { '@theirs': 'https://theirs.test/{name}.json' } };
    const snapshot = JSON.stringify(existing);

    mergeRegistriesIntoComponentsJson(existing, [PRIVATE]);

    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('refuses the same namespace twice', () => {
    expect(() => assertRegistries([PRIVATE, { ...PRIVATE }])).toThrow(/configured twice/);
  });
});

describe('buildRegistryEnv', () => {
  it('resolves a token from the vault into the child env', () => {
    const result = buildRegistryEnv([PRIVATE], (key) =>
      key === 'external:ui-kit-registry-acme' ? 'tok-123' : null,
    );

    expect(result.env).toEqual({ ACME_REGISTRY_TOKEN: 'tok-123' });
    expect(result.missing).toEqual([]);
  });

  it('reports a missing token instead of letting the CLI fail with a bare 401', () => {
    const result = buildRegistryEnv([PRIVATE], () => null);

    expect(result.env).toEqual({});
    expect(result.missing).toEqual(['@acme']);
  });

  it('treats a blank stored token as missing', () => {
    expect(buildRegistryEnv([PRIVATE], () => '   ').missing).toEqual(['@acme']);
  });

  it('ignores a keyless registry', () => {
    const result = buildRegistryEnv(
      [{ namespace: '@public', url: 'https://r.test/{name}.json' }],
      () => null,
    );

    expect(result.env).toEqual({});
    expect(result.missing).toEqual([]);
  });
});

describe('registrySecretKey', () => {
  it('derives a stable vault key from the namespace', () => {
    expect(registrySecretKey('@acme')).toBe('external:ui-kit-registry-acme');
  });
});

describe('envVarReferences', () => {
  it('finds a variable referenced in headers, params or a URL', () => {
    const refs = envVarReferences({
      registries: {
        '@acme': { url: 'https://a.test/{name}.json', headers: { Authorization: 'Bearer ${T}' } },
        '@other': { url: 'https://b.test/{name}.json', params: { token: '${T}' } },
        '@third': 'https://c.test/{name}.json?k=${OTHER}',
      },
    });

    expect([...(refs.get('T') ?? [])].sort()).toEqual(['@acme', '@other']);
    expect([...(refs.get('OTHER') ?? [])]).toEqual(['@third']);
  });

  it('is empty with no registries at all', () => {
    expect(envVarReferences(null).size).toBe(0);
    expect(envVarReferences({ style: 'new-york' }).size).toBe(0);
  });
});

describe('registryEntryNeedsAuth', () => {
  it('completes a bare mapping and leaves the project\'s own auth alone', () => {
    expect(registryEntryNeedsAuth(PRIVATE, PRIVATE.url)).toBe(true);
    expect(registryEntryNeedsAuth(PRIVATE, { url: PRIVATE.url })).toBe(true);
    expect(
      registryEntryNeedsAuth(PRIVATE, {
        url: PRIVATE.url,
        headers: { Authorization: 'Bearer ${THEIR_TOKEN}' },
      }),
    ).toBe(false);
    expect(
      registryEntryNeedsAuth(PRIVATE, { url: PRIVATE.url, params: { token: 'x' } }),
    ).toBe(false);
  });

  it('never completes an entry for a registry that declares no auth', () => {
    const open: UiKitRegistry = { namespace: '@open', url: PRIVATE.url };

    expect(registryEntryNeedsAuth(open, PRIVATE.url)).toBe(false);
  });
});

describe('resolveRegistryAuthContract', () => {
  const stored = PRIVATE.auth;

  it('keeps the stored contract when no token is typed again', () => {
    // The bug: re-saving an existing private registry without the token
    // dropped its auth, the project's components.json went back to a bare
    // URL, installs ran unauthenticated, and nothing reported a missing key.
    expect(
      resolveRegistryAuthContract({ namespace: '@acme', stored, hasToken: false }),
    ).toEqual(stored);
  });

  it('derives one for a registry whose shape ships with Nexus, before any token', () => {
    // This is what makes the environment-variable path reachable: with no
    // auth at all, nothing ever looks the variable up.
    expect(
      resolveRegistryAuthContract({ namespace: '@shadcnuikit', hasToken: false }),
    ).toEqual({
      kind: 'header',
      name: 'Authorization',
      envVar: 'SHADCNUIKIT_REGISTRY_TOKEN',
    });
  });

  it('derives one when a token is being saved now', () => {
    expect(
      resolveRegistryAuthContract({ namespace: '@acme', hasToken: true })?.envVar,
    ).toBe('ACME_REGISTRY_TOKEN');
  });

  it('leaves an unknown registry with no token public', () => {
    expect(
      resolveRegistryAuthContract({ namespace: '@open', hasToken: false }),
    ).toBeUndefined();
  });

  it('lets an explicit contract win over the stored one', () => {
    const declared = { kind: 'param' as const, name: 'token', envVar: 'MY_TOKEN' };

    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        declared,
        stored,
        hasToken: true,
      }),
    ).toEqual(declared);
  });
});

describe('resolveRegistryToken', () => {
  it('prefers the vault over the environment', () => {
    expect(
      resolveRegistryToken(PRIVATE, () => 'from-vault', {
        ACME_REGISTRY_TOKEN: 'from-env',
      }),
    ).toBe('from-vault');
  });

  it('falls back to the operator\'s own environment variable', () => {
    // How an operator provisions their OWN machines and team once instead of
    // pasting a key per install — and the reason no key needs to be embedded
    // in the product, where it would be published rather than shared.
    expect(
      resolveRegistryToken(PRIVATE, () => null, { ACME_REGISTRY_TOKEN: ' from-env ' }),
    ).toBe('from-env');
  });

  it('treats blank as absent on both sides', () => {
    expect(resolveRegistryToken(PRIVATE, () => '   ', { ACME_REGISTRY_TOKEN: '' })).toBeNull();
    expect(resolveRegistryToken(PRIVATE, () => undefined, {})).toBeNull();
  });

  it('reads no variable for a registry that declares no auth', () => {
    const open: UiKitRegistry = { namespace: '@open', url: PRIVATE.url };

    expect(
      resolveRegistryToken(open, () => null, { ACME_REGISTRY_TOKEN: 'from-env' }),
    ).toBeNull();
  });
});

describe('buildScopedRegistryEnv — the token cannot be hijacked', () => {
  const base = {
    registries: [PRIVATE],
    referenced: ['@acme'],
    lookupSecret: () => 'tok-abc',
  };

  it('releases the token when only its own namespace references it', () => {
    const components = {
      registries: {
        '@acme': { url: PRIVATE.url, headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' } },
      },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({ ACME_REGISTRY_TOKEN: 'tok-abc' });
    expect(result.hijacked).toEqual([]);
  });

  it('withholds the ENVIRONMENT token too when the variable is hijacked', () => {
    // The vault is not the only source any more, so the hijack check has to
    // sit above the whole resolution rather than above the vault read.
    const components = {
      registries: {
        '@acme': PRIVATE.url,
        '@evil': {
          url: 'https://evil.test/{name}.json',
          headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
        },
      },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      lookupSecret: () => null,
      environment: { ACME_REGISTRY_TOKEN: 'from-env' },
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({});
    expect(result.hijacked).toEqual(['@acme']);
  });

  it('withholds it when another entry in the project file names the variable', () => {
    // The leak: shadcn interpolates ${VAR} into config that lives in the
    // project's own file, so a second entry pointing elsewhere would receive
    // our token.
    const components = {
      registries: {
        '@acme': PRIVATE.url,
        '@evil': {
          url: 'https://evil.test/{name}.json',
          headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
        },
      },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({});
    expect(result.hijacked).toEqual(['@acme']);
  });

  it('releases nothing when the run also touches a namespace we cannot vouch for', () => {
    const components = {
      registries: { '@acme': PRIVATE.url, '@unknown': 'https://who.test/{name}.json' },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      referenced: ['@acme', '@unknown'],
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({});
    expect(result.hijacked).toEqual(['@unknown']);
  });

  it('still trusts the public @shadcn namespace alongside a private one', () => {
    const components = {
      registries: {
        '@acme': { url: PRIVATE.url, headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' } },
      },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      referenced: ['@shadcn', '@acme'],
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({ ACME_REGISTRY_TOKEN: 'tok-abc' });
  });

  it('withholds the token when the project entry interpolates nothing', () => {
    // The bare mapping: same host, no `${VAR}`. shadcn would send the request
    // unauthenticated and get a 401 while the secret rode along in the
    // child's environment for nothing.
    const components = { registries: { '@acme': PRIVATE.url } };

    const result = buildScopedRegistryEnv({
      ...base,
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({});
    expect(result.unreferenced).toEqual(['@acme']);
    expect(result.hijacked).toEqual([]);
  });

  it('withholds it when the project put its OWN auth on our namespace', () => {
    const components = {
      registries: {
        '@acme': { url: PRIVATE.url, headers: { Authorization: 'Bearer ${THEIR_TOKEN}' } },
      },
    };

    const result = buildScopedRegistryEnv({
      ...base,
      projectUrls: projectRegistryUrls(components),
      envReferences: envVarReferences(components),
    });

    expect(result.env).toEqual({});
    expect(result.unreferenced).toEqual(['@acme']);
  });
});
