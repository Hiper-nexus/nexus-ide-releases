import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUiKitCli } from './ui-kit-cli';
import { callMcpToolOnce } from './ui-kit-mcp-call';

let fixture = '';
afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  fixture = '';
});

function installFixture(source: string) {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kit espaço & Unicode-'));
  const npmBin = path.join(fixture, 'node_modules', 'npm', 'bin');
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'npx.cmd'), '@echo off\r\nexit /b 99\r\n');
  fs.writeFileSync(path.join(npmBin, 'npx-cli.js'), source);
  vi.stubEnv('PATH', `${fixture};${path.dirname(process.execPath)};${process.env.PATH ?? ''}`);
  return fixture;
}

describe.skipIf(process.platform !== 'win32')('UI-kit native Windows launch', () => {
  it('runs the CLI without a batch shell and preserves literal argv', async () => {
    const cwd = installFixture('console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['view', 'espaço-ação', 'a&b', '%PATH%', 'a"b', 'trailing\\'];
    const result = await runUiKitCli({ kit: 'shadcn', cwd, args });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['-y', 'shadcn@latest', ...args]);
  });

  it('starts the stdio MCP server through Node and completes a real handshake', async () => {
    const cwd = installFixture(`
      const readline = require('node:readline');
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', line => {
        const m = JSON.parse(line);
        if (m.id) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id,
          result: m.method === 'initialize' ? { protocolVersion: '2025-06-18' }
            : { content: [{ type: 'text', text: 'Windows MCP ok' }] } }));
      });
    `);
    const result = await callMcpToolOnce({ kit: 'boardui', cwd,
      method: 'tools/call', tool: 'get_theme', timeoutMs: 5000 });
    expect(result.text).toBe('Windows MCP ok');
    expect(result.isError).toBe(false);
  });
});
