/**
 * MiniMax Code (`mcode`) recebe o MCP do Nexus na TUI (F-678).
 *
 * Medido no mcode 0.5.8 (28/09): a TUI e o `exec` leem servidores MCP de
 * `<dataDir>/mcp.json` ("User-configured"), do `.mcp.json` do projeto e de
 * plugins locais — não do `config.yaml`. `MINIMAX_DATA_DIR` não serve de
 * overlay: a credencial é chaveada pelo caminho do data dir e o login some.
 * Servidor stdio herda o `process.env` inteiro do mcode.
 *
 * Por isso o Nexus registra UMA vez, em `~/.minimax/mcp.json` (mesclado, sem
 * tocar nos servidores do usuário), um servidor stdio `nexus` que roda uma
 * ponte própria em `~/.nexus/mcp-bridge/`. Cada pane passa URL e bearer da
 * sessão só por ENV (`NEXUS_MCP_URL`/`NEXUS_MCP_TOKEN`); nada de segredo vai
 * para disco. Fora do Nexus (sem ENV) a ponte responde com zero ferramentas.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCliBinary } from '../path-resolver';

export const MINIMAX_NEXUS_MCP_SERVER = 'nexus';
const BRIDGE_FILE = 'nexus-mcp-bridge.cjs';

/** Ponte stdio → HTTP loopback do Nexus. Sem ENV, servidor vazio (não quebra o /mcp). */
export const MINIMAX_NEXUS_MCP_BRIDGE_SCRIPT = String.raw`'use strict';
// Nexus IDE — ponte MCP para o MiniMax Code. Gerado pelo Nexus; não edite.
const http = require('node:http');
const readline = require('node:readline');

const rawUrl = process.env.NEXUS_MCP_URL || '';
const token = process.env.NEXUS_MCP_TOKEN || '';
let target = null;
try {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) target = parsed;
} catch {}
const connected = Boolean(target && token);

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function idle(payload) {
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'id')) return null;
  if (payload.method === 'initialize') {
    const version = payload.params && payload.params.protocolVersion ? payload.params.protocolVersion : '2025-03-26';
    return { jsonrpc: '2.0', id: payload.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'nexus', version: '1.0.0' } } };
  }
  if (payload.method === 'tools/list') return { jsonrpc: '2.0', id: payload.id, result: { tools: [] } };
  if (payload.method === 'ping') return { jsonrpc: '2.0', id: payload.id, result: {} };
  return { jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'Nexus MCP is only available inside a Nexus pane' } };
}

function forward(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 500;
        if (status === 202 || status === 204 || text.length === 0) return resolve(null);
        if (status < 200 || status >= 300) return reject(new Error('Nexus MCP HTTP ' + status));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Nexus MCP returned a non-JSON response')); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Nexus MCP bridge request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function failure(payload, error) {
  const id = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null;
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 256);
  return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Nexus MCP bridge failed: ' + message } };
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let payload;
  try { payload = JSON.parse(line); } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Nexus MCP bridge received invalid JSON' } });
    return;
  }
  queue = queue.then(async () => {
    if (!connected) {
      const reply = idle(payload);
      if (reply) write(reply);
      return;
    }
    try {
      const reply = await forward(payload);
      if (reply !== null) write(reply);
    } catch (error) {
      write(failure(payload, error));
    }
  });
});
input.on('close', () => { void queue.finally(() => process.exit(0)); });
`;

export interface MinimaxMcpRegistrationOptions {
  /** HOME real do operador (onde moram `~/.minimax` e `~/.nexus`). */
  home?: string;
  /** Node que roda a ponte; padrão: o `node` do PATH resolvido em absoluto. */
  nodePath?: string;
}

function writeFileAtomic(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, value, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function minimaxBridgePath(home = os.homedir()): string {
  return path.join(home, '.nexus', 'mcp-bridge', BRIDGE_FILE);
}

export function minimaxUserMcpPath(home = os.homedir()): string {
  return path.join(home, '.minimax', 'mcp.json');
}

/**
 * Garante a ponte e a entrada `nexus` em `~/.minimax/mcp.json`. Idempotente:
 * só grava quando o conteúdo muda. `mcp.json` ilegível (JSON quebrado) nunca
 * é sobrescrito — o pane segue sem o MCP em vez de apagar config do usuário.
 */
export function ensureMinimaxNexusMcpRegistration(
  options: MinimaxMcpRegistrationOptions = {},
): { registered: boolean; reason?: string } {
  const home = options.home ?? os.homedir();
  const bridge = minimaxBridgePath(home);
  let current: string | null = null;
  try {
    current = fs.readFileSync(bridge, 'utf8');
  } catch {
    current = null;
  }
  if (current !== MINIMAX_NEXUS_MCP_BRIDGE_SCRIPT) {
    writeFileAtomic(bridge, MINIMAX_NEXUS_MCP_BRIDGE_SCRIPT);
  }

  const configPath = minimaxUserMcpPath(home);
  const document = readJsonObject(configPath);
  if (document === null) {
    return { registered: false, reason: 'mcp.json do MiniMax ilegível — não foi alterado' };
  }
  const servers =
    document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
      ? (document.mcpServers as Record<string, unknown>)
      : {};
  const command = options.nodePath ?? resolveCliBinary('node')?.binPath ?? 'node';
  const entry = { command, args: [bridge] };
  if (JSON.stringify(servers[MINIMAX_NEXUS_MCP_SERVER]) === JSON.stringify(entry)) {
    return { registered: true };
  }
  const next = { ...document, mcpServers: { ...servers, [MINIMAX_NEXUS_MCP_SERVER]: entry } };
  writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { registered: true };
}

/** ENV do pane MiniMax: a ponte registrada lê a sessão daqui. */
export function prepareMinimaxMcpSession(
  mcpUrl: string,
  token: string,
  options: MinimaxMcpRegistrationOptions = {},
): { env: Record<string, string>; registered: boolean; reason?: string } {
  const registration = ensureMinimaxNexusMcpRegistration(options);
  return {
    env: registration.registered ? { NEXUS_MCP_URL: mcpUrl, NEXUS_MCP_TOKEN: token } : {},
    ...registration,
  };
}

export function minimaxUserConfigPath(home = os.homedir()): string {
  return path.join(home, '.minimax', 'config.yaml');
}

export const MINIMAX_FULL_ACCESS_MODE = 'bypassPermissions';

/**
 * F-692: a TUI do mcode não tem flag nem ENV de permissão; o modo vem só da
 * chave de topo `permissionMode` do `config.yaml` (`default` pergunta a cada
 * ferramenta). Todo pane gravável do Nexus roda livre — o mesmo invariante
 * "sempre full-auto" das outras CLIs (`--dangerously-skip-permissions`,
 * `--yolo`, `--always-approve`…) —, então o Nexus garante
 * `permissionMode: bypassPermissions` ("Full access") antes do spawn.
 * Edição TEXTUAL e idempotente: só a linha de topo muda (ou entra no fim);
 * comentários, ordem e o resto do arquivo ficam como o usuário deixou.
 */
export function ensureMinimaxFullAccess(
  options: { readonly home?: string } = {},
): { changed: boolean; reason?: string } {
  const file = minimaxUserConfigPath(options.home ?? os.homedir());
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { changed: false, reason: 'config.yaml do MiniMax ilegível — não foi alterado' };
    }
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const line = `permissionMode: ${MINIMAX_FULL_ACCESS_MODE}`;
  const current = /^permissionMode:[ \t]*([^\r\n]*?)[ \t]*\r?$/mu.exec(raw);
  if (current) {
    const value = current[1]!.replace(/\s+#.*$/u, '').trim().replace(/^(['"])(.*)\1$/u, '$2');
    if (value === MINIMAX_FULL_ACCESS_MODE) return { changed: false };
    writeFileAtomic(file, raw.replace(/^permissionMode:[^\r\n]*/mu, line));
    return { changed: true };
  }
  const separator = raw.length === 0 || raw.endsWith('\n') ? '' : eol;
  writeFileAtomic(file, `${raw}${separator}${line}${eol}`);
  return { changed: true };
}
