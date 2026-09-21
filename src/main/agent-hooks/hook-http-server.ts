/**
 * Loopback HTTP ingest for managed Claude/Codex hook scripts (Gap A).
 * Posts never authorize evidence/mission completion (§12.4).
 * Auth: shared token written to endpoint file under userData (not project .nexus).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time token comparison (avoids leaking the token via timing). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ingestAgentHookFormBody, ingestAgentHookStatus } from './hook-ingest';
import { HOOK_REQUEST_MAX_BYTES } from '../../shared/agent-hook-listener';

export type HookHttpServerHandle = {
  readonly port: number;
  readonly token: string;
  readonly endpointFilePath: string;
  close: () => Promise<void>;
};

let active: HookHttpServerHandle | null = null;

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeEndpointFile(
  path: string,
  port: number,
  token: string,
): void {
  // Token is hex-only from randomBytes; reject anything else before shell export.
  if (!/^[0-9a-f]+$/i.test(token)) {
    throw new Error('hook-http-server: token must be hex');
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('hook-http-server: invalid port');
  }
  mkdirSync(dirname(path), { recursive: true });
  // Sourced by managed shell scripts (NEXUS_AGENT_HOOK_ENDPOINT).
  const body = [
    `export NEXUS_AGENT_HOOK_PORT='${port}'`,
    `export NEXUS_AGENT_HOOK_TOKEN='${token}'`,
    '',
  ].join('\n');
  writeFileSync(path, body, { mode: 0o600 });
}

/**
 * Start loopback-only hook listener. Returns handle with port/token/endpoint path.
 * `userDataPath` must be Electron userData (or test tmp) — never a project tree.
 */
export async function startAgentHookHttpServer(options: {
  userDataPath: string;
  token?: string;
}): Promise<HookHttpServerHandle> {
  if (active) return active;

  const token = options.token ?? randomBytes(24).toString('hex');
  const endpointFilePath = join(options.userDataPath, 'agent-hooks', 'endpoint.env');

  const server: Server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, token);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'internal' }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only — never bind 0.0.0.0.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('hook-http-server: failed to bind loopback port');
  }
  const port = addr.port;
  writeEndpointFile(endpointFilePath, port, token);

  const handle: HookHttpServerHandle = {
    port,
    token,
    endpointFilePath,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (active === handle) active = null;
          try {
            if (existsSync(endpointFilePath)) unlinkSync(endpointFilePath);
          } catch {
            // best effort
          }
          resolve();
        });
      }),
  };
  active = handle;
  return handle;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const match = url.pathname.match(/^\/hook\/([a-z0-9-]+)$/i);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'not-found' }));
    return;
  }
  const headerToken =
    req.headers['x-nexus-agent-hook-token'] ??
    req.headers['x-orca-agent-hook-token'];
  if (typeof headerToken !== 'string' || !tokenMatches(headerToken, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'unauthorized' }));
    return;
  }

  const body = await readBody(req, HOOK_REQUEST_MAX_BYTES);
  const contentType = String(req.headers['content-type'] ?? '');
  let result;
  if (contentType.includes('application/json')) {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'invalid-json' }));
      return;
    }
    const sessionId =
      typeof (payload as { paneKey?: unknown })?.paneKey === 'string'
        ? (payload as { paneKey: string }).paneKey
        : typeof (payload as { sessionId?: unknown })?.sessionId === 'string'
          ? (payload as { sessionId: string }).sessionId
          : '';
    const mimoToken = req.headers['x-nexus-mimo-session-token'];
    result = ingestAgentHookStatus(sessionId, payload, {
      pathname: url.pathname,
      ...(typeof mimoToken === 'string' ? { mimoToken } : {}),
    });
  } else {
    // Form-urlencoded (managed scripts).
    const params = new URLSearchParams(body);
    const sessionId = params.get('paneKey') ?? params.get('sessionId') ?? '';
    result = ingestAgentHookFormBody(sessionId, body, url.pathname);
  }

  // Explicitly refuse evidence authorization in the HTTP response surface.
  const bodyOut =
    result.ok === true
      ? {
          ok: true,
          paneSessionState: result.paneSessionState,
          authorizesEvidence: false as const,
          authorizesMissionCompletion: false as const,
        }
      : { ok: false, reason: result.reason, authorizesEvidence: false as const };

  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(bodyOut));
}

export function getActiveAgentHookHttpServer(): HookHttpServerHandle | null {
  return active;
}

export async function stopAgentHookHttpServer(): Promise<void> {
  if (active) await active.close();
}
