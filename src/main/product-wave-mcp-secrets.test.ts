import { describe, expect, it } from 'vitest';
import type { McpHubConfig } from './mcp-hub/mcp-hub-core';
import { vaultRefFieldKeys } from './mcp-hub/mcp-hub-core';
import {
  hydrateMcpHubSecretsInMemory,
  sealMcpHubSecretsInMemory,
  vaultRefOf,
} from './mcp-hub/mcp-hub-secrets';
import { maskMcpHubForUi } from './product-wave-ipc';

/**
 * N2 — renderer projection of the MCP hub. A planted vault ref must never
 * resolve, and even a legitimate resolved secret must reach the renderer
 * masked (value-origin, not field name).
 */
describe('mcp hub UI projection (product-wave)', () => {
  const SCOPE = 'scope-ui';

  function refFieldsOf(config: McpHubConfig): Map<string, ReadonlySet<string>> {
    return new Map(
      config.servers.map((server) => [server.id, vaultRefFieldKeys(server)]),
    );
  }

  it('malicious auth:* ref never resolves and never reaches the renderer', () => {
    const store = new Map<string, string>([
      ['auth:license-seal-key', 'SEAL-KEY-PLAINTEXT'],
    ]);
    const malicious: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'firecrawl',
          name: 'Firecrawl',
          transport: 'stdio',
          tools: [],
          source: 'nexus',
          env: { DISPLAY_VALUE: vaultRefOf('auth:license-seal-key') },
        },
      ],
    };

    // Resolution is refused (hydrate throws) — the vault reader is never hit
    // for the reserved key, and the renderer mask hides the planted ref.
    expect(() =>
      hydrateMcpHubSecretsInMemory(malicious, store, SCOPE),
    ).toThrow(/vault ref rejected/i);

    const ui = maskMcpHubForUi(malicious, refFieldsOf(malicious));
    const serialized = JSON.stringify(ui);
    expect(serialized).not.toContain('SEAL-KEY-PLAINTEXT');
    expect(serialized).not.toContain('auth:license-seal-key');
    expect(ui.servers[0]?.env?.DISPLAY_VALUE).toBe('[REDACTED]');
  });

  it('legitimate MCP server secret hydrates for the process and is masked for the renderer', () => {
    const store = new Map<string, string>();
    const plaintext: McpHubConfig = {
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
          headers: { Authorization: 'Bearer tok-xyz' },
        },
      ],
    };
    const sealed = sealMcpHubSecretsInMemory(plaintext, SCOPE, store);
    const refFields = refFieldsOf(sealed);

    // Server process sees plaintext.
    const runtime = hydrateMcpHubSecretsInMemory(sealed, store, SCOPE);
    expect(runtime.servers[0]?.env?.FIRECRAWL_API_KEY).toBe(
      'sk-live-super-secret',
    );
    expect(runtime.servers[0]?.headers?.Authorization).toBe('Bearer tok-xyz');

    // Renderer never does — even after hydration (value-origin mask).
    const ui = maskMcpHubForUi(runtime, refFields);
    const serialized = JSON.stringify(ui);
    expect(serialized).not.toContain('sk-live-super-secret');
    expect(serialized).not.toContain('Bearer tok-xyz');
    expect(ui.servers[0]?.env?.PATH).toBe('/usr/bin');
    expect(ui.servers[0]?.env?.FIRECRAWL_API_KEY).toMatch(/REDACTED/);
    expect(ui.servers[0]?.headers?.Authorization).toMatch(/REDACTED/);
  });
});
