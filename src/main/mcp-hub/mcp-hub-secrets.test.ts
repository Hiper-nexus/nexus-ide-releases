import { describe, expect, it } from 'vitest';
import type { McpHubConfig } from './mcp-hub-core';
import {
  countMcpHubVaultRefs,
  hydrateMcpHubSecretsInMemory,
  isVaultRef,
  mcpHubConfigHasPlaintextSecrets,
  mcpHubVaultScope,
  sealMcpHubSecretsInMemory,
  vaultRefOf,
} from './mcp-hub-secrets';

const sample: McpHubConfig = {
  schemaVersion: 1,
  servers: [
    {
      id: 'firecrawl',
      name: 'Firecrawl',
      transport: 'stdio',
      tools: ['scrape'],
      source: 'nexus',
      env: {
        FIRECRAWL_API_KEY: 'sk-live-super-secret',
        PATH: '/usr/bin',
      },
      headers: {
        Authorization: 'Bearer tok-xyz',
        'X-Client': 'nexus',
      },
    },
  ],
};

describe('mcp hub vault seals', () => {
  it('moves secret env/headers into the vault and leaves non-secrets plain', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(sample, 'scope-a', store);

    expect(mcpHubConfigHasPlaintextSecrets(sealed)).toBe(false);
    expect(countMcpHubVaultRefs(sealed)).toBe(2);
    expect(sealed.servers[0]?.env?.PATH).toBe('/usr/bin');
    expect(sealed.servers[0]?.headers?.['X-Client']).toBe('nexus');
    expect(isVaultRef(sealed.servers[0]?.env?.FIRECRAWL_API_KEY ?? '')).toBe(
      true,
    );
    expect(store.size).toBe(2);

    const hydrated = hydrateMcpHubSecretsInMemory(sealed, store);
    expect(hydrated.servers[0]?.env?.FIRECRAWL_API_KEY).toBe(
      'sk-live-super-secret',
    );
    expect(hydrated.servers[0]?.headers?.Authorization).toBe('Bearer tok-xyz');
  });

  it('is idempotent: sealing vault refs does not double-write', () => {
    const store = new Map<string, string>();
    const once = sealMcpHubSecretsInMemory(sample, 'scope-b', store);
    const twice = sealMcpHubSecretsInMemory(once, 'scope-b', store);
    expect(twice).toEqual(once);
    expect(store.size).toBe(2);
  });

  it('fails closed on vault miss at hydrate', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(sample, 'scope-c', store);
    store.clear();
    expect(() => hydrateMcpHubSecretsInMemory(sealed, store)).toThrow(
      /vault miss/i,
    );
  });

  it('scopes vault keys by workspace hash (no path leak)', () => {
    const a = mcpHubVaultScope('/Users/alice/proj');
    const b = mcpHubVaultScope('/Users/bob/proj');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{24}$/);
    expect(vaultRefOf('mcphub:x')).toBe('__nexus_vault__:mcphub:x');
  });

  it('refuses to vault UI redaction placeholders (fail-closed)', () => {
    const store = new Map<string, string>();
    const masked: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'firecrawl',
          name: 'Firecrawl',
          transport: 'stdio',
          tools: [],
          source: 'nexus',
          env: { FIRECRAWL_API_KEY: '[REDACTED]' },
        },
      ],
    };
    expect(() => sealMcpHubSecretsInMemory(masked, 'scope-d', store)).toThrow(
      /masked placeholder/i,
    );
    expect(store.size).toBe(0);
  });
});
