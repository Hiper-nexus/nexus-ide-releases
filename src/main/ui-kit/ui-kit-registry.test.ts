import { describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  assertRegistries,
  assertRegistryNamespace,
  assertRegistryUrl,
  buildRegistryEnv,
  mergeRegistriesIntoComponentsJson,
  registrySecretKey,
  renderRegistryEntry,
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
