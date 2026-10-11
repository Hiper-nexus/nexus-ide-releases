import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver')>();
  return { ...actual, resolveCliBinary: vi.fn(actual.resolveCliBinary) };
});

import { resolveCliBinary } from '../path-resolver';
import { buildAcpMcpStdioServer } from './acp-mcp-stdio-bridge';

const realExecPath = process.execPath;
let scratch = '';
let server: http.Server | null = null;

afterEach(async () => {
  process.execPath = realExecPath;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function startMcpEndpoint(): Promise<string> {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as { id: number };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** Runs the spec the way an ACP agent does: command + args, env merged over its own. */
function runBridge(spec: ReturnType<typeof buildAcpMcpStdioServer>, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of spec.env) env[name] = value;
    const child = spawn(spec.command, [...spec.args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve(stdout));
    child.stdin.end(`${line}\n`);
  });
}

describe('ACP MCP stdio bridge', () => {
  it.skipIf(process.platform === 'win32')(
    'F-1209: a ponte responde mesmo com o fuse RunAsNode desligado no app empacotado',
    async () => {
      // O app empacotado desliga o fuse RunAsNode (forge.config.ts): o binário
      // ignora ELECTRON_RUN_AS_NODE e --eval e só sobe o app (que, segunda
      // instância, sai). Este executável faz exatamente isso.
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-acp-bridge-'));
      const packagedApp = path.join(scratch, 'NexusIDE');
      fs.writeFileSync(packagedApp, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.execPath = packagedApp;

      const spec = buildAcpMcpStdioServer(await startMcpEndpoint(), 'token-1209');
      const stdout = await runBridge(
        spec,
        JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }),
      );

      // MCP stdio: one JSON-RPC message per line, ended by a real newline.
      expect(stdout).toBe(`${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } })}\n`);
    },
    15_000,
  );

  it('F-1234: sem node resolvível falha com spawn_failed acionável, não um command literal', () => {
    vi.mocked(resolveCliBinary).mockReturnValueOnce(null);
    expect(() => buildAcpMcpStdioServer('http://127.0.0.1:1/mcp', 'token-1234'))
      .toThrow(/^spawn_failed: node não encontrado no PATH/);
    expect(vi.mocked(resolveCliBinary)).toHaveBeenCalledWith('node');
  });
});
