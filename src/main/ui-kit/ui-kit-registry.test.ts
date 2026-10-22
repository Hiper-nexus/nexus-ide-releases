import { describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  assertRegistries,
  assertRegistry,
  buildScopedRegistryEnv,
  envVarReferences,
  projectRegistryUrls,
  assertRegistryNamespace,
  assertRegistryUrl,
  buildRegistryEnv,
  mergeRegistriesIntoComponentsJson,
  hostOfRegistryUrl,
  isRegistrySecretKey,
  normalizeConfiguredRegistries,
  persistableRegistry,
  planRegistryRemoval,
  registrySaveOutcome,
  operatorTokenForRegistry,
  registryEntryNeedsAuth,
  registrySecretKey,
  resolveRegistryAuthContract,
  renderRegistryEntry,
  resolveRegistryToken,
  withOperatorRegistries,
  type UiKitRegistry,
} from './ui-kit-registry';
import { operatorRegistryToken } from './ui-kit-operator-keys';

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
    // The kind and the header/param NAME stay the operator's; only the
    // variable is derived from the namespace (it selects a secret).
    expect(
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'header', name: 'X-Api-Key', envVar: 'ACME_API_KEY', scheme: 'raw' },
      }),
    ).toEqual({
      url: PRIVATE.url,
      headers: { 'X-Api-Key': '${ACME_REGISTRY_TOKEN}' },
    });

    expect(
      renderRegistryEntry({
        ...PRIVATE,
        auth: { kind: 'param', name: 'token', envVar: 'ACME_ACCESS_TOKEN' },
      }),
    ).toEqual({
      url: PRIVATE.url,
      params: { token: '${ACME_REGISTRY_TOKEN}' },
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
      // The message is the RUNNER's now: this validation calls
      // `assertSafeEnvName` instead of keeping a weaker copy of its rule.
    ).toThrow(/registry env var name must match/);
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

describe('persistableRegistry — settings never carry vault names', () => {
  it('strips the derived secretKey and keeps the rest verbatim', () => {
    // What the panel persists: the operator's registry configuration, nothing
    // else. A `secretKey` in settings is a vault name in a world-readable
    // file, and one a hand-edited row could point at somebody else's secret.
    const normalized = assertRegistry(PRIVATE);
    const persisted = persistableRegistry(normalized);

    expect(persisted.secretKey).toBeUndefined();
    expect(persisted).toEqual({
      namespace: '@acme',
      url: PRIVATE.url,
      auth: normalized.auth,
    });
  });
});

describe('normalizeConfiguredRegistries — a settings file is data, not a caller', () => {
  it('re-validates every row and drops an unusable one without breaking the panel', () => {
    // Hand-edited or stale settings: a row pointing at a non-https URL must
    // not ride into an install, and it must not take the valid rows with it.
    const rows = [
      assertRegistry(PRIVATE),
      { namespace: '@acme', url: 'http://insecure.test/{name}.json' },
      'not even an object',
      null,
    ];

    expect(normalizeConfiguredRegistries(rows)).toEqual([assertRegistry(PRIVATE)]);
  });

  it('overwrites a foreign secretKey the settings carried', () => {
    // The same rule `assertRegistry` enforces on the way in: a row read back
    // from disk gets its vault name DERIVED again, so a settings file that
    // carries `auth:session` cannot aim a later removal at that secret.
    const rows = [{ ...PRIVATE, secretKey: 'auth:session' }];

    expect(normalizeConfiguredRegistries(rows)[0]?.secretKey).toBe(
      'external:ui-kit-registry-acme',
    );
  });

  it('returns an empty list when nothing usable is configured', () => {
    expect(normalizeConfiguredRegistries([])).toEqual([]);
    expect(normalizeConfiguredRegistries([undefined, 42])).toEqual([]);
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

describe('the vault name of a registry is DERIVED, never carried', () => {
  it('overwrites a secretKey that came from outside', () => {
    // The attack: the generic `settings.orchSet` bridge persists registries,
    // so a compromised renderer could point one at `auth:session`, pass the
    // configured-URL checks, and have the install read that secret and hand
    // it to the registry's host.
    const poisoned = assertRegistry({
      ...PRIVATE,
      secretKey: 'auth:session',
    });

    expect(poisoned.secretKey).toBe('external:ui-kit-registry-acme');
  });

  it('derives one even when none was given', () => {
    const bare: UiKitRegistry = { namespace: '@acme', url: PRIVATE.url };

    expect(assertRegistry(bare).secretKey).toBe('external:ui-kit-registry-acme');
  });

  it('refuses to READ any name outside the registry namespace', () => {
    // `getSecret` has no reserved-name guard — only writes do — so this is
    // the guard at the one place a registry token is read.
    const vault = (key: string) =>
      key === 'auth:session' ? 'operator-session-token' : null;

    expect(
      resolveRegistryToken({ ...PRIVATE, secretKey: 'auth:session' }, vault, {}),
    ).toBeNull();
    expect(isRegistrySecretKey('auth:session')).toBe(false);
    expect(isRegistrySecretKey('external:ui-kit-registry-acme')).toBe(true);
    expect(isRegistrySecretKey('external:boardui-license-key')).toBe(false);
  });

  it('still reads the token under its own derived name', () => {
    const vault = (key: string) =>
      key === 'external:ui-kit-registry-acme' ? 'tok-abc' : null;

    expect(resolveRegistryToken(assertRegistry(PRIVATE), vault, {})).toBe('tok-abc');
  });
});

describe('the saved env name is the one the runner accepts', () => {
  it('refuses a name with no credential word, before anything is persisted', () => {
    // `FOO` used to pass the UPPER_SNAKE_CASE check here, get persisted, reach
    // `components.json` as `${FOO}`, and only THEN be refused by the run — so
    // the project's configuration was edited by an install that could never
    // execute.
    expect(() =>
      assertRegistry({
        ...PRIVATE,
        auth: { kind: 'header', name: 'Authorization', envVar: 'FOO' },
      }),
    ).toThrow(UiKitCliError);
  });

  it('refuses a name from a family that can redirect the child', () => {
    for (const envVar of ['NODE_OPTIONS_TOKEN', 'LD_PRELOAD_KEY', 'PATH']) {
      expect(() =>
        assertRegistry({
          ...PRIVATE,
          auth: { kind: 'header', name: 'Authorization', envVar },
        }),
      ).toThrow(UiKitCliError);
    }
  });

  it('still validates a declared name, then replaces it with the derived one', () => {
    // The shape check stays (a malformed or non-credential name throws above),
    // but the SAVED name is always the namespace's own.
    for (const envVar of ['ACME_REGISTRY_TOKEN', 'MY_API_KEY', 'VENDOR_SECRET']) {
      expect(
        assertRegistry({
          ...PRIVATE,
          auth: { kind: 'header', name: 'Authorization', envVar },
        }).auth?.envVar,
      ).toBe('ACME_REGISTRY_TOKEN');
    }
  });
});

describe('a host change is a credential boundary, checked first', () => {
  const stored = PRIVATE.auth;
  const elsewhere = 'https://elsewhere.test/r/{name}.json';

  it('beats a DECLARED contract: the caller cannot talk past it', () => {
    // My first version checked the host after `declared`, and `declared`
    // comes from the caller — so naming a contract plus a new host walked
    // straight through to the old host's token.
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        declared: stored,
        stored,
        storedUrl: PRIVATE.url,
        url: elsewhere,
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('beats the known-registry branch too', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@shadcnuikit',
        storedUrl: 'https://shadcnuikit.com/r/{name}.json',
        url: elsewhere,
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('beats a DECLARED contract with NO stored row at all', () => {
    // The hole the host check could not see: it compares against the STORED
    // url, so with no settings row there is nothing to compare and `declared`
    // — which comes from the caller — walked straight through. A contract is
    // exactly what releases the token still sitting in the vault for that
    // namespace, so this is the same leak with the comparison missing instead
    // of failed.
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        declared: stored,
        url: elsewhere,
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('lets a token entered for the new host through', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        stored,
        storedUrl: PRIVATE.url,
        url: elsewhere,
        hasToken: true,
      })?.envVar,
    ).toBe('ACME_REGISTRY_TOKEN');
  });

  it('still refuses to carry the stored contract to another PATH on the same host', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        stored,
        storedUrl: PRIVATE.url,
        url: 'https://registry.acme.test/other/{name}.json',
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('compares hosts, not strings', () => {
    expect(hostOfRegistryUrl('https://Registry.Acme.TEST/r/{name}.json')).toBe(
      'registry.acme.test',
    );
    // An unparseable value can only equal itself — "unknown shape" must not
    // accidentally match a real host.
    expect(hostOfRegistryUrl('not a url')).toBe('not a url');
  });
});

describe('the ENV name of a registry is derived too', () => {
  it('reads only the namespace own variable, never one settings named', () => {
    // The sibling of the vault-key hole: `OPENAI_API_KEY` and `GH_TOKEN` both
    // satisfy `assertSafeEnvName`, so a compromised renderer could name one
    // of them plus a chosen URL and have the install forward that credential.
    const hostile: UiKitRegistry = {
      ...PRIVATE,
      secretKey: undefined,
      auth: { kind: 'header', name: 'Authorization', envVar: 'OPENAI_API_KEY' },
    };
    const environment = {
      OPENAI_API_KEY: 'sk-operator-openai',
      GH_TOKEN: 'ghp-operator',
      ACME_REGISTRY_TOKEN: 'tok-acme',
    };

    expect(resolveRegistryToken(hostile, () => null, environment)).toBe('tok-acme');
  });

  it('answers null when the namespace own variable is unset', () => {
    const hostile: UiKitRegistry = {
      ...PRIVATE,
      secretKey: undefined,
      auth: { kind: 'header', name: 'Authorization', envVar: 'GH_TOKEN' },
    };

    expect(
      resolveRegistryToken(hostile, () => null, { GH_TOKEN: 'ghp-operator' }, () => null),
    ).toBeNull();
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

  it('keeps the stored contract when no token is typed again, same host', () => {
    // The bug: re-saving an existing private registry without the token
    // dropped its auth, the project's components.json went back to a bare
    // URL, installs ran unauthenticated, and nothing reported a missing key.
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        stored,
        storedUrl: PRIVATE.url,
        url: PRIVATE.url,
        hasToken: false,
      }),
    ).toEqual(stored);
  });

  it('drops it when the namespace is re-pointed at ANOTHER host', () => {
    // Preserving by namespace alone kept the auth and the old token under the
    // same derived vault key, and the next install released that token to the
    // new host. With no contract, `resolveRegistryToken` is never consulted —
    // and nothing is deleted from the vault to achieve it.
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        stored,
        storedUrl: PRIVATE.url,
        url: 'https://elsewhere.test/r/{name}.json',
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('accepts the new host once a token is entered for it', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@acme',
        stored,
        storedUrl: PRIVATE.url,
        url: 'https://elsewhere.test/r/{name}.json',
        hasToken: true,
      })?.envVar,
    ).toBe('ACME_REGISTRY_TOKEN');
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
    // pasting a key per install.
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

describe('resolveRegistryToken — the bundled operator key is the LAST resort', () => {
  // The vendor registry the operator bundles a token for: same namespace and
  // URL as KNOWN_UI_KIT_REGISTRIES, or the bundle stays shut.
  const BUNDLED: UiKitRegistry = {
    namespace: '@shadcnuikit',
    url: 'https://shadcnuikit.com/r/{name}.json',
    auth: { kind: 'header', name: 'Authorization', envVar: 'SHADCNUIKIT_REGISTRY_TOKEN' },
    secretKey: 'external:ui-kit-registry-shadcnuikit',
  };

  it('uses the bundled token when vault and env are empty', () => {
    expect(resolveRegistryToken(BUNDLED, () => null, {})).toBe(
      operatorRegistryToken('@shadcnuikit'),
    );
  });

  it('prefers the vault over the bundle', () => {
    expect(
      resolveRegistryToken(BUNDLED, () => 'from-vault', {}),
    ).toBe('from-vault');
  });

  it('prefers the machine\'s own environment over the bundle', () => {
    expect(
      resolveRegistryToken(BUNDLED, () => null, {
        SHADCNUIKIT_REGISTRY_TOKEN: 'from-env',
      }),
    ).toBe('from-env');
  });

  it('withholds the bundled token when the registry points somewhere else', () => {
    // A client's settings must not be able to redirect the operator's key to
    // another host: only the vendor's own URL releases it.
    const redirected: UiKitRegistry = {
      ...BUNDLED,
      url: 'https://evil.test/r/{name}.json',
    };

    expect(resolveRegistryToken(redirected, () => null, {})).toBeNull();
  });

  it('offers no bundled token for a namespace it carries none for', () => {
    expect(operatorTokenForRegistry(PRIVATE)).toBeNull();
  });
});

describe('withOperatorRegistries — zero-setup, settings stay authoritative', () => {
  it('adds the bundled namespace to an empty configuration', () => {
    const merged = withOperatorRegistries([]);

    expect(merged.map((registry) => registry.namespace)).toEqual([
      '@shadcnuikit',
    ]);
    // The entry must be a valid registry: it goes through the same release
    // gates (assertRegistries) as everything else.
    expect(() => assertRegistries(merged)).not.toThrow();
    expect(merged[0].url).toBe('https://shadcnuikit.com/r/{name}.json');
    expect(merged[0].auth?.envVar).toBe('SHADCNUIKIT_REGISTRY_TOKEN');
    expect(merged[0].secretKey).toBe('external:ui-kit-registry-shadcnuikit');
  });

  it('never overrides a settings entry for the same namespace', () => {
    const mine: UiKitRegistry = {
      namespace: '@shadcnuikit',
      url: 'https://my-mirror.test/r/{name}.json',
      auth: { kind: 'header', name: 'Authorization', envVar: 'MY_TOKEN' },
      secretKey: 'external:ui-kit-registry-shadcnuikit',
    };

    expect(withOperatorRegistries([mine])).toEqual([mine]);
  });

  it('appends the bundled namespace after the configured ones', () => {
    const merged = withOperatorRegistries([PRIVATE]);

    expect(merged.map((registry) => registry.namespace)).toEqual([
      '@acme',
      '@shadcnuikit',
    ]);
  });

  it('returns the same array when every bundled namespace is already configured', () => {
    // While the bundle carries @shadcnuikit, this is the only "nothing to
    // add" that exists: the namespace is present, so settings stay verbatim.
    const configured: UiKitRegistry[] = [PRIVATE, {
      namespace: '@shadcnuikit',
      url: 'https://shadcnuikit.com/r/{name}.json',
      auth: { kind: 'header', name: 'Authorization', envVar: 'SHADCNUIKIT_REGISTRY_TOKEN' },
      secretKey: 'external:ui-kit-registry-shadcnuikit',
    }];

    expect(withOperatorRegistries(configured)).toBe(configured);
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

describe('the preset fallback is bounded by the preset host', () => {
  const PRESET = 'https://shadcnuikit.com/r/{name}.json';

  it('refuses to derive preset auth for a known namespace pointed elsewhere', () => {
    // The hole the host check left open: with the settings row GONE (so no
    // `storedUrl` to compare) a known namespace derived its contract for ANY
    // URL, and the install then released the token still sitting in the vault
    // for that namespace to whatever host the new URL names.
    expect(
      resolveRegistryAuthContract({
        namespace: '@shadcnuikit',
        url: 'https://elsewhere.test/r/{name}.json',
        hasToken: false,
      }),
    ).toBeUndefined();
  });

  it('still derives it at the preset host, which is what makes the ENV path reachable', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@shadcnuikit',
        url: PRESET,
        hasToken: false,
      })?.envVar,
    ).toBe('SHADCNUIKIT_REGISTRY_TOKEN');
  });

  it('accepts another path on the preset host: same host, same credential scope', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@shadcnuikit',
        url: 'https://shadcnuikit.com/registry/v2/{name}.json',
        hasToken: false,
      })?.envVar,
    ).toBe('SHADCNUIKIT_REGISTRY_TOKEN');
  });

  it('derives it anyway when a fresh token comes with the new URL', () => {
    expect(
      resolveRegistryAuthContract({
        namespace: '@shadcnuikit',
        url: 'https://elsewhere.test/r/{name}.json',
        hasToken: true,
      })?.envVar,
    ).toBe('SHADCNUIKIT_REGISTRY_TOKEN');
  });
});

describe('removing a registry waits for the vault', () => {
  const rows: readonly UiKitRegistry[] = [
    PRIVATE,
    { namespace: '@other', url: 'https://other.test/r/{name}.json' },
  ];

  it('removes the row once the token is gone', () => {
    const plan = planRegistryRemoval({
      registries: rows,
      namespace: '@acme',
      cleared: { ok: true },
    });

    expect(plan.removed).toBe(true);
    expect(plan.removed && plan.registries.map((entry) => entry.namespace)).toEqual([
      '@other',
    ]);
  });

  it('KEEPS the row when the vault refused, and says why', () => {
    // Removing the row while the secret stays would tell the panel the
    // registry is gone with its credential still in the vault — and re-adding
    // that namespace would quietly pick the supposedly removed token up again.
    const plan = planRegistryRemoval({
      registries: rows,
      namespace: '@acme',
      cleared: { ok: false, error: 'keychain locked' },
    });

    expect(plan.removed).toBe(false);
    expect(!plan.removed && plan.error).toMatch(/keychain locked/);
  });

  it('still says something when the vault refused without a reason', () => {
    const plan = planRegistryRemoval({
      registries: rows,
      namespace: '@acme',
      cleared: { ok: false },
    });

    expect(plan.removed).toBe(false);
    expect(!plan.removed && plan.error.length).toBeGreaterThan(0);
  });
});

describe('saving a registry is proven by what landed on disk', () => {
  const SAVED = { namespace: '@acme', url: 'https://registry.acme.test/r/{name}.json' };

  it('confirms the save when the row is in the persisted settings', () => {
    const outcome = registrySaveOutcome({ ...SAVED, persisted: [SAVED] });

    expect(outcome.saved).toBe(true);
  });

  it('refuses when the write was DROPPED, which it is in silence', () => {
    // `replaceOrchSettings` returns the PREVIOUS settings when the merged
    // object fails the schema — a 33rd registry against the schema's max of
    // 32, for instance. It throws nothing, so the receipt went out, the panel
    // cleared every field, and the token written a moment earlier was left
    // with no registry to belong to.
    const outcome = registrySaveOutcome({ ...SAVED, persisted: [] });

    expect(outcome.saved).toBe(false);
    expect(!outcome.saved && outcome.error.length).toBeGreaterThan(0);
  });

  it('refuses when the namespace landed pointing somewhere else', () => {
    const outcome = registrySaveOutcome({
      ...SAVED,
      persisted: [{ namespace: '@acme', url: 'https://other.test/r/{name}.json' }],
    });

    expect(outcome.saved).toBe(false);
  });

  it('refuses when there is nothing to read back', () => {
    expect(registrySaveOutcome({ ...SAVED, persisted: undefined }).saved).toBe(false);
  });
});
