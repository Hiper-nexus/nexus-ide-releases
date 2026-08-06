import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_MANIFEST_SCHEMA } from './agent-plugin-manifest';
import { readAgentPluginMcp } from './agent-plugin-mcp';

const PLUGIN_ROOT = path.resolve('/plugins/acme-tools');
const PLUGIN_DATA = path.resolve('/plugin-data/acme-tools');

function read(raw: unknown) {
  return readAgentPluginMcp(raw, {
    pluginRoot: PLUGIN_ROOT,
    pluginDataRoot: PLUGIN_DATA,
  });
}

describe('Agent Plugins v1.0.0 MCP validation', () => {
  it('maps valid stdio, Streamable HTTP, and SSE entries without starting them', () => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['--data', '${PLUGIN_DATA}/index'],
          env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          cwd: '${PLUGIN_ROOT}',
        },
        remote: {
          type: 'streamable-http',
          url: 'https://mcp.example.test/rpc',
          headers: { 'X-Tenant': 'public' },
        },
        legacy: {
          type: 'sse',
          url: 'http://127.0.0.1:4310/events',
        },
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.degraded).toEqual([]);
    expect(verdict.servers).toHaveLength(3);
    expect(verdict.servers[0]).toMatchObject({
      name: 'local',
      transport: 'stdio',
      command: path.join(PLUGIN_ROOT, 'bin/server'),
      args: ['--data', path.join(PLUGIN_DATA, 'index')],
      cwd: PLUGIN_ROOT,
      env: {
        CONFIG: path.join(PLUGIN_ROOT, 'config.json'),
        PLUGIN_ROOT,
        PLUGIN_DATA,
      },
      activation: 'explicit-user-action',
      permissionGate: 'PreToolUse',
    });
    expect(verdict.servers[1]).toMatchObject({
      name: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/rpc',
    });
    expect(verdict.servers[2]).toMatchObject({
      name: 'legacy',
      transport: 'sse',
    });
  });

  it('disables only MCP when its top-level schema version is unsupported', () => {
    const verdict = read({
      $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
      mcpServers: {},
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('1.0.0');
    expect(verdict.reason).toContain('1.1.0');
  });

  it('disables MCP for unknown top-level fields but leaves that failure isolated', () => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: {},
      fallback: true,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('fallback');
  });

  it('skips one invalid server and preserves valid siblings', () => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: {
        valid: { type: 'stdio', command: 'node', args: ['server.js'] },
        invalid: { type: 'websocket', url: 'wss://example.test' },
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.servers.map((server) => server.name)).toEqual(['valid']);
    expect(verdict.degraded).toEqual([
      expect.objectContaining({ component: 'mcpServers', entry: 'invalid' }),
    ]);
  });

  it.each([
    [
      'shell command string',
      { type: 'stdio', command: 'node server.js' },
    ],
    [
      'reserved env',
      { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/override' } },
    ],
    [
      'cwd traversal',
      { type: 'stdio', command: 'node', cwd: './../../../outside' },
    ],
    [
      'variant field mixing',
      { type: 'stdio', command: 'node', url: 'https://example.test' },
    ],
  ])('skips an unsafe stdio entry: %s', (_label, server) => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: { unsafe: server },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.servers).toEqual([]);
    expect(verdict.degraded[0]?.entry).toBe('unsafe');
  });

  it.each([
    ['non-loopback HTTP', 'http://mcp.example.test/rpc'],
    ['URL credentials', 'https://user:pass@mcp.example.test/rpc'],
    ['URL fragment', 'https://mcp.example.test/rpc#secret'],
  ])('skips an unsafe remote URL: %s', (_label, url) => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: { unsafe: { type: 'streamable-http', url } },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.servers).toEqual([]);
  });

  it('skips duplicate case-insensitive or credential-bearing headers', () => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: {
        duplicate: {
          type: 'streamable-http',
          url: 'https://mcp.example.test',
          headers: { 'X-Tenant': 'a', 'x-tenant': 'b' },
        },
        credential: {
          type: 'streamable-http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer package-secret' },
        },
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.servers).toEqual([]);
    expect(verdict.degraded.map((notice) => notice.entry).sort()).toEqual([
      'credential',
      'duplicate',
    ]);
  });

  it('does not expand placeholders in URLs or headers', () => {
    const verdict = read({
      $schema: MCP_MANIFEST_SCHEMA,
      mcpServers: {
        literal: {
          type: 'streamable-http',
          url: 'https://mcp.example.test/${PLUGIN_ROOT}',
          headers: { 'X-Path': '${PLUGIN_DATA}' },
        },
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.servers[0]).toMatchObject({
      url: 'https://mcp.example.test/${PLUGIN_ROOT}',
      headers: { 'X-Path': '${PLUGIN_DATA}' },
    });
  });
});
