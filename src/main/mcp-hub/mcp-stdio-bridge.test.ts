import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isMcpSharedHubEnabled,
  isStdioMcpServerEntry,
  McpStdioBridge,
  nativeStdioServerDescriptors,
  projectMcpServersThroughHub,
  resolveMcpHubBridgeKeys,
  resolveNativeStdioServerDescriptor,
  type McpStdioServerDescriptor,
} from './mcp-stdio-bridge';

// ── pure classifier / projector tests (no process spawned) ────────────────

describe('isStdioMcpServerEntry', () => {
  it('accepts a bare stdio entry (no type field)', () => {
    expect(isStdioMcpServerEntry({ command: 'npx', args: ['pkg'] })).toBe(true);
  });

  it('accepts an explicit type:"stdio" entry', () => {
    expect(isStdioMcpServerEntry({ type: 'stdio', command: 'npx' })).toBe(true);
  });

  it('rejects an http entry even if it also carries a stray command field', () => {
    expect(
      isStdioMcpServerEntry({ type: 'http', url: 'https://x', command: 'npx' }),
    ).toBe(false);
  });

  it('rejects an entry with a url but no explicit type', () => {
    expect(isStdioMcpServerEntry({ url: 'https://x', command: 'npx' })).toBe(false);
  });

  it('rejects a command-less entry', () => {
    expect(isStdioMcpServerEntry({ args: [] })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isStdioMcpServerEntry('npx')).toBe(false);
    expect(isStdioMcpServerEntry(null)).toBe(false);
  });
});

describe('nativeStdioServerDescriptors', () => {
  it('extracts only the stdio-shaped entries, sanitizing args/env', () => {
    const descriptors = nativeStdioServerDescriptors({
      github: { command: 'npx', args: ['-y', '@github/mcp'], env: { TOKEN: 'x', BAD: 1 } },
      sentry: { type: 'http', url: 'https://mcp.sentry.dev' },
      broken: { args: ['no-command'] },
    });
    expect(descriptors).toEqual([
      {
        key: 'github',
        command: 'npx',
        args: ['-y', '@github/mcp'],
        env: { TOKEN: 'x' },
      },
    ]);
  });

  it('returns empty for a non-object input', () => {
    expect(nativeStdioServerDescriptors(undefined)).toEqual([]);
    expect(nativeStdioServerDescriptors(null)).toEqual([]);
  });
});

describe('projectMcpServersThroughHub', () => {
  const mcpServers = {
    github: { command: 'npx', args: ['-y', '@github/mcp'] },
    sentry: { type: 'http', url: 'https://mcp.sentry.dev' },
  };

  it('passes everything through unchanged when there is no bridge', () => {
    expect(projectMcpServersThroughHub(mcpServers, 'tok', undefined)).toBe(mcpServers);
  });

  it('passes everything through unchanged when the bridge has no keys', () => {
    expect(
      projectMcpServersThroughHub(mcpServers, 'tok', { baseUrl: 'http://x/hub', keys: [] }),
    ).toBe(mcpServers);
  });

  it('rewrites only the bridgeable stdio keys to http, leaving http/sse and unlisted keys intact', () => {
    const out = projectMcpServersThroughHub(mcpServers, 'tok-123', {
      baseUrl: 'http://127.0.0.1:4000/hub',
      keys: ['github'],
    }) as Record<string, unknown>;
    expect(out.github).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4000/hub/github',
      headers: { Authorization: 'Bearer tok-123' },
    });
    expect(out.sentry).toBe(mcpServers.sentry);
  });

  it('never rewrites a key that is only stdio-shaped in the bridge list by coincidence', () => {
    // The key is in `keys`, but the profile now has an http entry under that
    // name (e.g. edited between spawn-time key resolution and this write) —
    // isStdioMcpServerEntry still gates the rewrite.
    const mixed = { github: { type: 'http', url: 'https://x' } };
    const out = projectMcpServersThroughHub(mixed, 'tok', {
      baseUrl: 'http://x/hub',
      keys: ['github'],
    }) as Record<string, unknown>;
    expect(out.github).toBe(mixed.github);
  });

  it('URL-encodes keys with special characters', () => {
    const withSlash = { 'io.github.owner/server': { command: 'npx' } };
    const out = projectMcpServersThroughHub(withSlash, 'tok', {
      baseUrl: 'http://x/hub',
      keys: ['io.github.owner/server'],
    }) as Record<string, { url: string }>;
    expect(out['io.github.owner/server']!.url).toBe(
      'http://x/hub/io.github.owner%2Fserver',
    );
  });
});

describe('isMcpSharedHubEnabled', () => {
  it('defaults to enabled', () => {
    expect(isMcpSharedHubEnabled({})).toBe(true);
  });

  it('is disabled by the explicit escape hatch', () => {
    expect(isMcpSharedHubEnabled({ NEXUS_MCP_SHARED_HUB_DISABLED: '1' })).toBe(false);
  });
});

// ── native profile resolution (real fs, temp $HOME) ───────────────────────

describe('resolveNativeStdioServerDescriptor / resolveMcpHubBridgeKeys', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function tempHome(mcpServers: unknown): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-home-'));
    roots.push(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers }));
    return home;
  }

  it('resolves a known stdio key', () => {
    const home = tempHome({ github: { command: 'npx', args: ['-y', 'x'] } });
    expect(resolveNativeStdioServerDescriptor('github', home)).toEqual({
      key: 'github',
      command: 'npx',
      args: ['-y', 'x'],
      env: {},
    });
  });

  it('returns null for an unknown key or a non-stdio key', () => {
    const home = tempHome({ sentry: { type: 'http', url: 'https://x' } });
    expect(resolveNativeStdioServerDescriptor('sentry', home)).toBeNull();
    expect(resolveNativeStdioServerDescriptor('missing', home)).toBeNull();
  });

  it('lists bridgeable keys, ignoring non-stdio entries', () => {
    const home = tempHome({
      github: { command: 'npx' },
      firecrawl: { command: 'npx' },
      sentry: { type: 'http', url: 'https://x' },
    });
    expect([...resolveMcpHubBridgeKeys(home)].sort()).toEqual(['firecrawl', 'github']);
  });

  it('degrades to an empty list when ~/.claude.json is missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-home-'));
    roots.push(home);
    expect(resolveMcpHubBridgeKeys(home)).toEqual([]);
    expect(resolveNativeStdioServerDescriptor('github', home)).toBeNull();
  });
});

// ── real backend process: fake stdio MCP server ───────────────────────────

/**
 * A minimal MCP stdio server used only by these tests. Speaks ndjson by
 * default (what @modelcontextprotocol/sdk's stdio transport speaks); pass
 * argv[2] === 'content-length' for the LSP-style framing variant, to
 * exercise the reader's auto-detection.
 */
const FAKE_SERVER_SOURCE = String.raw`
'use strict';
const readline = require('node:readline');
const framing = process.argv[2] === 'content-length' ? 'content-length' : 'ndjson';
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(message) {
  const body = JSON.stringify(message);
  if (framing === 'content-length') {
    process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body);
  } else {
    process.stdout.write(body + '\n');
  }
}

let pendingServerRequest = null;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (pendingServerRequest && message.id === pendingServerRequest.id) {
    const resolve = pendingServerRequest.resolve;
    pendingServerRequest = null;
    resolve(message);
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-stdio-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    if (name === 'whoami') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: String(process.pid) }] },
      });
      return;
    }
    if (name === 'crash') {
      process.exit(1);
    }
    if (name === 'trigger-backend-request') {
      const requestId = 'srv-' + Date.now() + '-' + Math.random();
      new Promise((resolve) => {
        pendingServerRequest = { id: requestId, resolve };
        send({ jsonrpc: '2.0', id: requestId, method: 'sampling/createMessage', params: {} });
      }).then((reply) => {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  gotError: Boolean(reply.error),
                  code: reply.error ? reply.error.code : null,
                }),
              },
            ],
          },
        });
      });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
  }
});
`;

function callToolText(response: { result?: unknown } | null): string {
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('McpStdioBridge (real fake stdio backend)', () => {
  const roots: string[] = [];
  const bridges: McpStdioBridge[] = [];

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.disposeAll();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fakeDescriptor(framing?: 'content-length'): McpStdioServerDescriptor {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-fixture-'));
    roots.push(root);
    const scriptPath = path.join(root, 'server.cjs');
    fs.writeFileSync(scriptPath, FAKE_SERVER_SOURCE);
    return {
      key: 'fake',
      command: process.execPath,
      args: framing ? [scriptPath, framing] : [scriptPath],
      env: {},
    };
  }

  function newBridge(options?: ConstructorParameters<typeof McpStdioBridge>[0]): McpStdioBridge {
    const bridge = new McpStdioBridge(options);
    bridges.push(bridge);
    return bridge;
  }

  it('initializes the backend once and answers tools/call (ndjson framing)', async () => {
    const bridge = newBridge();
    const descriptor = fakeDescriptor();

    const init = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(init?.result).toMatchObject({
      serverInfo: { name: 'fake-stdio-mcp' },
    });

    const call = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    expect(call?.id).toBe(2);
    expect(callToolText(call)).toMatch(/^\d+$/);
  });

  it('auto-detects Content-Length framing from the backend', async () => {
    const bridge = newBridge();
    const descriptor = fakeDescriptor('content-length');

    const call = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/call',
      params: { name: 'whoami' },
    });
    expect(call?.id).toBe('a');
    expect(callToolText(call)).toMatch(/^\d+$/);
  });

  it('two concurrent clients share ONE spawned backend process', async () => {
    const bridge = newBridge();
    const descriptor = fakeDescriptor();

    const [clientA, clientB] = await Promise.all([
      bridge.handle(descriptor, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami' },
      }),
      bridge.handle(descriptor, {
        jsonrpc: '2.0',
        id: 1, // same id as A on purpose — a second pane, independent stream
        method: 'tools/call',
        params: { name: 'whoami' },
      }),
    ]);

    expect(callToolText(clientA)).toBe(callToolText(clientB));
    expect(clientA?.id).toBe(1);
    expect(clientB?.id).toBe(1);
  });

  it('never leaves a backend-initiated request hanging', async () => {
    const bridge = newBridge();
    const descriptor = fakeDescriptor();

    const response = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'trigger-backend-request' },
    });
    const payload = JSON.parse(callToolText(response)) as { gotError: boolean; code: number };
    expect(payload.gotError).toBe(true);
    expect(payload.code).toBe(-32601);
  });

  it('surfaces a crash as a JSON-RPC error, then respawns after the backoff window', async () => {
    const bridge = newBridge({ respawnBackoffMs: 30 });
    const descriptor = fakeDescriptor();

    const before = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami' },
    });
    const pidBefore = callToolText(before);

    const crashResponse = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'crash' },
    });
    expect(crashResponse?.error).toBeTruthy();

    const duringBackoff = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'whoami' },
    });
    expect(duringBackoff?.error?.message).toMatch(/cooling down|exited/);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const after = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'whoami' },
    });
    const pidAfter = callToolText(after);
    expect(pidAfter).toMatch(/^\d+$/);
    expect(pidAfter).not.toBe(pidBefore);
  });

  it('drops client notifications instead of forwarding them', async () => {
    const bridge = newBridge();
    const descriptor = fakeDescriptor();
    await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const notified = await bridge.handle(descriptor, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified).toBeNull();
  });
});
