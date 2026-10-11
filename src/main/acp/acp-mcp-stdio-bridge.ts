/**
 * Adapts ACP's stdio MCP server shape to Nexus' authenticated loopback HTTP
 * transport. ACP agents receive MCP servers as child processes, while the
 * Nexus registry deliberately remains the single owner of tool dispatch,
 * confirmations, receipts and mission gates.
 *
 * The bridge is intentionally a tiny self-contained CommonJS program run with
 * Node and --eval, so no extra bundled file or npm dependency is needed on
 * another PC.
 */
import type { AcpMcpServerSpec } from '../../shared/acp-protocol';
import { resolveCliBinary } from '../path-resolver';

const ACP_MCP_BRIDGE_SCRIPT = String.raw`
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');

const target = new URL(process.env.NEXUS_MCP_URL || '');
const token = process.env.NEXUS_MCP_TOKEN || '';
if (!token || !/^https?:$/.test(target.protocol)) {
  process.stderr.write('Nexus ACP MCP bridge is missing its authenticated endpoint\n');
  process.exit(64);
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 256);
}

function request(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'x-nexus-transport': 'acp-stdio',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode === 202 || res.statusCode === 204 || responseBody.length === 0) {
          resolve(null);
          return;
        }
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(new Error('Nexus MCP HTTP ' + String(res.statusCode || 500)));
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error('Nexus MCP returned a non-JSON response'));
        }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Nexus MCP bridge request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function responseForFailure(payload, error) {
  const id = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null)
    : null;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: 'Nexus MCP bridge failed: ' + boundedError(error) },
  };
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Nexus MCP bridge received invalid JSON' } }) + '\n');
    return;
  }
  queue = queue.then(async () => {
    try {
      const result = await request(payload);
      if (result !== null) process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify(responseForFailure(payload, error)) + '\n');
    }
  });
});
input.on('close', () => {
  void queue.finally(() => process.exit(0));
});
`;

function assertLoopbackHttpUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
  ) {
    throw new Error('ACP MCP bridge requires Nexus\' loopback HTTP endpoint');
  }
  return parsed;
}

/** Build the only MCP server spec that ACP mission sessions may receive. */
export function buildAcpMcpStdioServer(
  url: string,
  token: string,
): AcpMcpServerSpec {
  const endpoint = assertLoopbackHttpUrl(url);
  if (!token.trim() || token.includes('\0')) {
    throw new Error('ACP MCP bridge token is missing or malformed');
  }
  // F-1209: not process.execPath + ELECTRON_RUN_AS_NODE. The packaged app
  // ships with the RunAsNode fuse off, so that binary ignores both and just
  // boots NexusIDE; the agent's MCP server never answered. Same Node the
  // other stdio bridges (minimax, muse, qwen) use.
  const node = resolveCliBinary('node')?.binPath;
  // F-1234: a literal 'node' left the ACP session without the nexus MCP in silence.
  if (!node) {
    throw new Error(
      'spawn_failed: node não encontrado no PATH — a sessão ACP precisa do Node.js para a ponte MCP do Nexus. ' +
        'Instale o Node.js (ou ponha o diretório dele no PATH do shell de login) e reabra o pane.',
    );
  }
  return Object.freeze({
    name: 'nexus',
    command: node,
    args: ['--eval', ACP_MCP_BRIDGE_SCRIPT],
    env: Object.freeze([
      { name: 'NEXUS_MCP_URL', value: endpoint.toString() },
      { name: 'NEXUS_MCP_TOKEN', value: token },
    ]),
  });
}

export function acpMcpBridgeScriptForTests(): string {
  return ACP_MCP_BRIDGE_SCRIPT;
}
