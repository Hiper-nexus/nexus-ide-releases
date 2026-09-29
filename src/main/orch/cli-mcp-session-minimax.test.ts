import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureMinimaxNexusMcpRegistration,
  minimaxBridgePath,
  minimaxUserMcpPath,
  prepareMinimaxMcpSession,
} from './cli-mcp-session-minimax';

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-minimax-mcp-'));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** Roda a ponte gerada com `env`, manda as mensagens e devolve as respostas. */
function runBridge(bridge: string, env: Record<string, string>, messages: object[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

describe('MiniMax Code recebe o MCP do Nexus pela ponte registrada (F-678)', () => {
  it('mescla a entrada nexus sem tocar nos servidores do usuário e é idempotente', () => {
    const home = tempHome();
    const config = minimaxUserMcpPath(home);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      version: 3,
      mcpServers: { supabase: { command: 'npx', args: ['supabase-mcp'] } },
    }));
    expect(ensureMinimaxNexusMcpRegistration({ home, nodePath: '/usr/bin/node' })).toEqual({ registered: true });
    const written = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect(written.version).toBe(3);
    expect(written.mcpServers.supabase).toEqual({ command: 'npx', args: ['supabase-mcp'] });
    expect(written.mcpServers.nexus).toEqual({ command: '/usr/bin/node', args: [minimaxBridgePath(home)] });
    expect(fs.existsSync(minimaxBridgePath(home))).toBe(true);

    const before = fs.statSync(config).mtimeMs;
    const snapshot = fs.readFileSync(config, 'utf8');
    ensureMinimaxNexusMcpRegistration({ home, nodePath: '/usr/bin/node' });
    expect(fs.readFileSync(config, 'utf8')).toBe(snapshot);
    expect(fs.statSync(config).mtimeMs).toBe(before);
  });

  it('mcp.json quebrado nunca é sobrescrito; o pane segue sem ENV do MCP', () => {
    const home = tempHome();
    const config = minimaxUserMcpPath(home);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '{ quebrado');
    const prepared = prepareMinimaxMcpSession('http://127.0.0.1:4000/mcp', 'tok', { home, nodePath: 'node' });
    expect(prepared.registered).toBe(false);
    expect(prepared.env).toEqual({});
    expect(fs.readFileSync(config, 'utf8')).toBe('{ quebrado');
  });

  it('o segredo da sessão só viaja por ENV, nunca para o disco', () => {
    const home = tempHome();
    const prepared = prepareMinimaxMcpSession('http://127.0.0.1:4000/mcp', 'segredo-da-sessao', { home, nodePath: 'node' });
    expect(prepared.env).toEqual({ NEXUS_MCP_URL: 'http://127.0.0.1:4000/mcp', NEXUS_MCP_TOKEN: 'segredo-da-sessao' });
    expect(fs.readFileSync(minimaxUserMcpPath(home), 'utf8')).not.toContain('segredo-da-sessao');
    expect(fs.readFileSync(minimaxBridgePath(home), 'utf8')).not.toContain('segredo-da-sessao');
  });

  it('fora de um pane do Nexus a ponte responde com zero ferramentas', async () => {
    const home = tempHome();
    ensureMinimaxNexusMcpRegistration({ home, nodePath: 'node' });
    const replies = await runBridge(minimaxBridgePath(home), {}, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nexus_pane_list' } },
    ]);
    expect(replies).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: '2025-06-18' }) }),
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32601 }) }),
    ]);
  });

  it('dentro do pane encaminha ao MCP do Nexus com o bearer da sessão', async () => {
    const home = tempHome();
    ensureMinimaxNexusMcpRegistration({ home, nodePath: 'node' });
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push(req.headers.authorization ?? '');
        const message = JSON.parse(body) as { id: number };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'nexus_handoff_submit' }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const replies = await runBridge(minimaxBridgePath(home), {
        NEXUS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        NEXUS_MCP_TOKEN: 'tok-sessao',
      }, [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }]);
      expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'nexus_handoff_submit' }] } }]);
      expect(seen).toEqual(['Bearer tok-sessao']);
    } finally {
      server.close();
    }
  });
});
