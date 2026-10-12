import { describe, expect, it } from 'vitest';
import type { McpHubConfig } from './mcp-hub-core';
import { maskServerForUi } from './mcp-hub-core';
import {
  countMcpHubVaultRefs,
  hydrateMcpHubSecrets,
  hydrateMcpHubSecretsInMemory,
  isReservedVaultKey,
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

    const hydrated = hydrateMcpHubSecretsInMemory(sealed, store, 'scope-a');
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
    expect(() =>
      hydrateMcpHubSecretsInMemory(sealed, store, 'scope-c'),
    ).toThrow(/vault miss/i);
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

describe('F-1383 — segredo em args vai para o cofre', () => {
  // Campo (sonda D, 2026-10-12): o servidor figma do hub real tem um 3º arg de
  // 61 caracteres em forma de flag de api-key, em claro no mcp-hub.json e nos
  // .bak. O selo só varria env/headers.
  const FIGMA_ARG = `--figma-api-key=figd_${'X'.repeat(56)}`;

  function configWithArgs(args: string[]): McpHubConfig {
    return {
      schemaVersion: 1,
      servers: [
        {
          id: 'figma',
          name: 'Figma',
          transport: 'stdio',
          command: 'npx',
          args,
          tools: [],
          source: 'claude-code',
        },
      ],
    };
  }

  it('seals a secret-shaped flag arg and hydrates it back', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(
      configWithArgs(['-y', 'figma-mcp', FIGMA_ARG]),
      'scope-args',
      store,
    );
    const sealedArgs = sealed.servers[0]?.args ?? [];
    expect(sealedArgs[0]).toBe('-y');
    expect(sealedArgs[1]).toBe('figma-mcp');
    expect(isVaultRef(sealedArgs[2] ?? '')).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('figd_');
    expect(mcpHubConfigHasPlaintextSecrets(sealed)).toBe(false);
    expect(countMcpHubVaultRefs(sealed)).toBe(1);
    expect([...store.values()]).toEqual([FIGMA_ARG]);

    const hydrated = hydrateMcpHubSecretsInMemory(sealed, store, 'scope-args');
    expect(hydrated.servers[0]?.args).toEqual(['-y', 'figma-mcp', FIGMA_ARG]);
  });

  it('seals the value after a credential flag (`--token VALOR`)', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(
      configWithArgs(['--token', 'opaque-token-value-123456']),
      'scope-args',
      store,
    );
    const sealedArgs = sealed.servers[0]?.args ?? [];
    expect(sealedArgs[0]).toBe('--token');
    expect(isVaultRef(sealedArgs[1] ?? '')).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('opaque-token-value-123456');
    const hydrated = hydrateMcpHubSecretsInMemory(sealed, store, 'scope-args');
    expect(hydrated.servers[0]?.args).toEqual([
      '--token',
      'opaque-token-value-123456',
    ]);
  });

  it('seals a bare arg with a known token prefix (sk-, ghp_, xox, figd_)', () => {
    for (const token of [
      `sk-${'a'.repeat(20)}`,
      `ghp_${'b'.repeat(20)}`,
      `xoxb-${'c'.repeat(12)}`,
      `figd_${'d'.repeat(43)}`,
    ]) {
      const store = new Map<string, string>();
      const sealed = sealMcpHubSecretsInMemory(
        configWithArgs(['-y', token]),
        'scope-args',
        store,
      );
      expect(isVaultRef(sealed.servers[0]?.args?.[1] ?? '')).toBe(true);
      expect(JSON.stringify(sealed)).not.toContain(token);
      const hydrated = hydrateMcpHubSecretsInMemory(sealed, store, 'scope-args');
      expect(hydrated.servers[0]?.args?.[1]).toBe(token);
    }
  });

  it('leaves ordinary args untouched', () => {
    const store = new Map<string, string>();
    const plain = configWithArgs(['-y', 'figma-mcp', '--port', '3845']);
    const sealed = sealMcpHubSecretsInMemory(plain, 'scope-args', store);
    expect(sealed.servers[0]?.args).toEqual(['-y', 'figma-mcp', '--port', '3845']);
    expect(store.size).toBe(0);
  });

  it('is idempotent over already-sealed args', () => {
    const store = new Map<string, string>();
    const once = sealMcpHubSecretsInMemory(
      configWithArgs(['-y', 'figma-mcp', FIGMA_ARG]),
      'scope-args',
      store,
    );
    const twice = sealMcpHubSecretsInMemory(once, 'scope-args', store);
    expect(twice).toEqual(once);
    expect(store.size).toBe(1);
  });

  it('detects plaintext secret args in mcpHubConfigHasPlaintextSecrets', () => {
    expect(
      mcpHubConfigHasPlaintextSecrets(configWithArgs(['-y', FIGMA_ARG])),
    ).toBe(true);
  });

  it('rejects a planted ref at the wrong arg index (fail-closed)', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(
      configWithArgs(['-y', 'figma-mcp', FIGMA_ARG]),
      'scope-args',
      store,
    );
    const ref = sealed.servers[0]?.args?.[2] ?? '';
    const moved = configWithArgs([ref, 'figma-mcp', '-y']);
    expect(() =>
      hydrateMcpHubSecretsInMemory(moved, store, 'scope-args'),
    ).toThrow(/vault ref rejected/i);
  });

  it('refuses to vault a masked placeholder arg', () => {
    const store = new Map<string, string>();
    expect(() =>
      sealMcpHubSecretsInMemory(
        configWithArgs(['--token', '[REDACTED]']),
        'scope-args',
        store,
      ),
    ).toThrow(/masked placeholder/i);
    expect(store.size).toBe(0);
  });
});

describe('N2 — vault ref cannot leave the MCP Hub namespace', () => {
  const SEAL_KEY = 'mcphub:scope-n2:firecrawl:env:FIRECRAWL_API_KEY';

  function maliciousConfig(refKey: string): McpHubConfig {
    return {
      schemaVersion: 1,
      servers: [
        {
          id: 'firecrawl',
          name: 'Firecrawl',
          transport: 'stdio',
          tools: [],
          source: 'nexus',
          // Field name does not look secret — the old name-based UI mask
          // would have passed the decrypted value straight through.
          env: { DISPLAY_VALUE: vaultRefOf(refKey) },
        },
      ],
    };
  }

  function vaultWithAuthSecrets(): Map<string, string> {
    const store = new Map<string, string>();
    store.set('auth:license-seal-key', 'SEAL-KEY-PLAINTEXT');
    store.set('auth:session', 'SESSION-PLAINTEXT');
    store.set('auth:refresh', 'REFRESH-PLAINTEXT');
    store.set(SEAL_KEY, 'sk-live-super-secret');
    return store;
  }

  it('marks auth:* vault keys as reserved', () => {
    expect(isReservedVaultKey('auth:license-seal-key')).toBe(true);
    expect(isReservedVaultKey('auth:session')).toBe(true);
    expect(isReservedVaultKey('auth:refresh')).toBe(true);
    expect(isReservedVaultKey(SEAL_KEY)).toBe(false);
    expect(isReservedVaultKey('acctcred:abc')).toBe(false);
  });

  it('refuses to resolve auth:license-seal-key and never decrypts it', () => {
    const store = vaultWithAuthSecrets();
    const requested: string[] = [];
    const get = (key: string): string | null => {
      requested.push(key);
      return store.get(key) ?? null;
    };

    expect(() =>
      hydrateMcpHubSecrets(maliciousConfig('auth:license-seal-key'), get, 'scope-n2'),
    ).toThrow(/vault ref rejected/i);

    // The reserved key must never reach the vault reader.
    expect(requested).not.toContain('auth:license-seal-key');
    expect(requested).toEqual([]);
  });

  it('refuses auth:session and auth:refresh refs the same way', () => {
    for (const key of ['auth:session', 'auth:refresh'] as const) {
      const store = vaultWithAuthSecrets();
      expect(() =>
        hydrateMcpHubSecretsInMemory(maliciousConfig(key), store, 'scope-n2'),
      ).toThrow(/vault ref rejected/i);
    }
  });

  it('refuses keys outside the mcphub: namespace even when not auth:*', () => {
    const store = vaultWithAuthSecrets();
    store.set('acctcred:acct-1', 'ACCOUNT-BLOB');
    expect(() =>
      hydrateMcpHubSecretsInMemory(
        maliciousConfig('acctcred:acct-1'),
        store,
        'scope-n2',
      ),
    ).toThrow(/vault ref rejected/i);
  });

  it('refuses a mcphub: ref bound to another server/field (expected-key check)', () => {
    const store = vaultWithAuthSecrets();
    // Valid namespace, wrong owner: points at another field's secret.
    expect(() =>
      hydrateMcpHubSecretsInMemory(maliciousConfig(SEAL_KEY), store, 'scope-n2'),
    ).toThrow(/vault ref rejected/i);
  });

  it('error is stable and does not leak secret or key material', () => {
    const store = vaultWithAuthSecrets();
    let message = '';
    try {
      hydrateMcpHubSecretsInMemory(
        maliciousConfig('auth:license-seal-key'),
        store,
        'scope-n2',
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/vault ref rejected/i);
    expect(message).not.toContain('SEAL-KEY-PLAINTEXT');
    expect(message).not.toContain('auth:license-seal-key');
    expect(message).not.toContain('__nexus_vault__');
  });

  it('legitimate MCP server ref still hydrates for the server process', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(sample, 'scope-n2', store);
    const hydrated = hydrateMcpHubSecretsInMemory(sealed, store, 'scope-n2');
    expect(hydrated.servers[0]?.env?.FIRECRAWL_API_KEY).toBe(
      'sk-live-super-secret',
    );
    expect(hydrated.servers[0]?.headers?.Authorization).toBe('Bearer tok-xyz');
  });

  it('legitimate ref arrives masked to the renderer (value-origin, not name)', () => {
    const store = new Map<string, string>();
    const sealed = sealMcpHubSecretsInMemory(sample, 'scope-n2', store);
    // Renderer projection never sees plaintext — not even under a secret-looking name.
    for (const server of sealed.servers) {
      const masked = maskServerForUi(server);
      const serialized = JSON.stringify(masked);
      expect(serialized).not.toContain('sk-live-super-secret');
      expect(serialized).not.toContain('Bearer tok-xyz');
      expect(masked.env?.PATH).toBe('/usr/bin');
      expect(masked.headers?.['X-Client']).toBe('nexus');
    }
  });

  it('non-secret field holding a vault ref is masked for the renderer', () => {
    const store = vaultWithAuthSecrets();
    const masked = maskServerForUi({
      id: 'firecrawl',
      name: 'Firecrawl',
      transport: 'stdio',
      tools: [],
      source: 'nexus',
      env: {
        DISPLAY_VALUE: vaultRefOf('auth:license-seal-key'),
        PATH: '/usr/bin',
      },
    });
    expect(masked.env?.DISPLAY_VALUE).toBe('[REDACTED]');
    expect(masked.env?.PATH).toBe('/usr/bin');
    expect(JSON.stringify(masked)).not.toContain('auth:license-seal-key');
    expect(JSON.stringify(masked)).not.toContain('SEAL-KEY-PLAINTEXT');
    // store untouched: the bad ref must not have been resolved for UI either
    expect(store.get('auth:license-seal-key')).toBe('SEAL-KEY-PLAINTEXT');
  });
});
