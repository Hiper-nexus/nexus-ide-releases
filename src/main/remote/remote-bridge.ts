import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type {
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
} from '../../shared/remote-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { writeJsonAtomic } from '../util/atomic-write';
import { REMOTE_CLIENT_HTML } from './remote-client-page';
import {
  getPaneAuthzInfo,
  listVisiblePaneSnapshots,
  readSessionOutput,
  requestPaneClose,
} from '../orch/pane-registry';
import { authorizePaneAccess } from '../orch/pane-authz';
import { getProjectDomainStores } from '../orch/project-domain-store-registry';
import {
  orchResizeSession,
  orchWriteSession,
} from '../pty/pty-manager';
import {
  clearRemoteTerminalStreams,
  encodeRemoteTerminalOutput,
  openRemoteTerminalStream,
  receiveRemoteTerminalFrame,
} from './remote-terminal-streams';
import { TerminalStreamOpcode } from '../../shared/terminal-stream-protocol';

interface TlsRecord {
  key: string;
  cert: string;
  fingerprint: string;
  hosts: string[];
}

interface TokenRecord {
  id: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
  projectId: string;
  checkoutId: string;
}

interface TokenFile {
  tokens: TokenRecord[];
}

interface AuthenticatedClient {
  tokenId: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  scope: ProjectExecutionScope;
}

const ROOT = path.join(os.homedir(), '.nexus', 'remote-bridge');
const TLS_FILE = path.join(ROOT, 'tls.json');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS = 16;
const UNAUTH_TIMEOUT_MS = 15_000;
// Bound the number of guesses against a single pairing code: once exceeded the
// code is rotated, so an attacker can never grind the full keyspace.
const MAX_PAIRING_FAILURES = 8;
// Unambiguous alphabet (no 0/O/1/I/L) over 8 chars ≈ 32^8 ≈ 1.1e12 keyspace.
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_LEN = 8;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function resolveTokenTtlMs(): number {
  if (process.env.NODE_ENV !== 'test') return DEFAULT_TOKEN_TTL_MS;
  const configured = Number(process.env.NEXUS_REMOTE_TOKEN_TTL_MS);
  return Number.isSafeInteger(configured) && configured >= 100
    ? configured
    : DEFAULT_TOKEN_TTL_MS;
}

const TOKEN_TTL_MS = resolveTokenTtlMs();

let server: https.Server | null = null;
let wss: WebSocketServer | null = null;
let port: number | null = null;
let boundHost: string | null = null;
let tlsRecord: TlsRecord | null = null;
let pairingFailures = 0;
let pairing = makePairing();
let tokenCache: TokenRecord[] | null = null;
let activeBridgeScope: ProjectExecutionScope | null = null;
const clients = new Set<WebSocket>();
const authenticatedClients = new Map<WebSocket, AuthenticatedClient>();
const rate = new Map<string, { count: number; resetAt: number }>();

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < PAIRING_LEN; i += 1) {
    out += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return out;
}

function makePairing(): { code: string; expiresAt: number } {
  pairingFailures = 0;
  return { code: randomCode(), expiresAt: Date.now() + PAIRING_TTL_MS };
}

function pairingCode(): { code: string; expiresAt: number } {
  if (Date.now() >= pairing.expiresAt) pairing = makePairing();
  return pairing;
}

function loadTokens(): TokenRecord[] {
  if (tokenCache) return tokenCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as TokenFile;
    tokenCache = (raw.tokens ?? []).filter(
      (token) =>
        typeof token.projectId === 'string' &&
        typeof token.checkoutId === 'string',
    );
  } catch {
    tokenCache = [];
  }
  return tokenCache;
}

/** Live, non-expired tokens; prunes expired records through to disk once. */
function readTokens(): TokenRecord[] {
  const all = loadTokens();
  const live = all.filter((token) => token.expiresAt > Date.now());
  if (live.length !== all.length) writeTokens(live);
  return live;
}

function writeTokens(tokens: TokenRecord[]): void {
  ensureRoot();
  writeJsonAtomic(TOKENS_FILE, { tokens });
  tokenCache = tokens;
}

function issueToken(
  scope: ProjectExecutionScope,
): { token: string; expiresAt: number; record: TokenRecord } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const record = {
    id: crypto.randomUUID(),
    hash: sha256Hex(token),
    createdAt: Date.now(),
    expiresAt,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
  };
  writeTokens([...readTokens(), record]);
  return { token, expiresAt, record };
}

function findValidToken(
  token: string,
  scope: ProjectExecutionScope,
): TokenRecord | undefined {
  if (!token) return undefined;
  const hash = sha256Hex(token);
  const right = Buffer.from(hash, 'hex');
  return readTokens().find((record) => {
    if (
      record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId
    ) {
      return false;
    }
    const left = Buffer.from(record.hash, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function clearAuthenticatedClient(ws: WebSocket): void {
  const current = authenticatedClients.get(ws);
  if (current) clearTimeout(current.expiryTimer);
  authenticatedClients.delete(ws);
}

function closeAuthenticatedClient(ws: WebSocket, reason: string): void {
  clearAuthenticatedClient(ws);
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(1008, reason);
  }
}

function scheduleExpiry(
  ws: WebSocket,
  tokenId: string,
  expiresAt: number,
  scope: ProjectExecutionScope,
): void {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    closeAuthenticatedClient(ws, 'token expired');
    return;
  }
  const expiryTimer = setTimeout(() => {
    const current = authenticatedClients.get(ws);
    if (!current || current.tokenId !== tokenId) return;
    scheduleExpiry(ws, tokenId, expiresAt, current.scope);
  }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  expiryTimer.unref?.();
  authenticatedClients.set(ws, {
    tokenId,
    expiresAt,
    expiryTimer,
    scope: Object.freeze({ ...scope }),
  });
}

function authenticateClient(
  ws: WebSocket,
  token: TokenRecord,
  scope: ProjectExecutionScope,
): void {
  clearAuthenticatedClient(ws);
  scheduleExpiry(ws, token.id, token.expiresAt, scope);
}

function isClientAuthenticated(ws: WebSocket): boolean {
  const current = authenticatedClients.get(ws);
  if (!current) return false;
  if (current.expiresAt <= Date.now()) {
    closeAuthenticatedClient(ws, 'token expired');
    return false;
  }
  const tokenStillExists = readTokens().some(
    (token) =>
      token.id === current.tokenId &&
      token.projectId === current.scope.projectId &&
      token.checkoutId === current.scope.checkoutId,
  );
  if (!tokenStillExists) {
    closeAuthenticatedClient(ws, 'tokens revoked');
    return false;
  }
  return true;
}

function closeAllAuthenticatedClients(reason: string): void {
  for (const ws of [...authenticatedClients.keys()]) {
    closeAuthenticatedClient(ws, reason);
  }
}

function clearAllAuthenticatedClients(): void {
  for (const ws of [...authenticatedClients.keys()]) {
    clearAuthenticatedClient(ws);
  }
}

function localIps(): string[] {
  const ips = new Set<string>(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const iface of entries ?? []) {
      if (!iface.internal) ips.add(iface.address);
    }
  }
  return [...ips];
}

async function ensureTls(): Promise<TlsRecord> {
  const wanted = localIps();
  if (tlsRecord && wanted.every((ip) => tlsRecord!.hosts.includes(ip))) {
    return tlsRecord;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(TLS_FILE, 'utf8')) as TlsRecord;
    if (
      raw.key &&
      raw.cert &&
      raw.fingerprint &&
      Array.isArray(raw.hosts) &&
      wanted.every((ip) => raw.hosts.includes(ip))
    ) {
      tlsRecord = raw;
      return raw;
    }
  } catch {
    // Generate below.
  }
  const altNames = [
    { type: 2 as const, value: 'localhost' },
    // selfsigned/node-forge IP SANs are IPv4; advertised URLs are IPv4 too.
    ...wanted
      .filter((ip) => !ip.includes(':'))
      .map((ip) => ({ type: 7 as const, ip })),
  ];
  const pems = await generate(
    [{ name: 'commonName', value: 'Nexus Remote Bridge' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  const record: TlsRecord = {
    key: pems.private,
    cert: pems.cert,
    fingerprint: certFingerprint256(pems.cert),
    hosts: wanted,
  };
  ensureRoot();
  writeJsonAtomic(TLS_FILE, record);
  tlsRecord = record;
  return record;
}

function certFingerprint256(certPem: string): string {
  try {
    return new crypto.X509Certificate(certPem).fingerprint256;
  } catch {
    return sha256Hex(certPem);
  }
}

function localUrls(currentPort: number): string[] {
  const urls = new Set<string>([`wss://127.0.0.1:${currentPort}`]);
  // Só anuncia IPs da LAN quando o bind é wildcard — bound a localhost, essas
  // URLs não funcionariam.
  if (boundHost === '0.0.0.0' || boundHost === '::') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const iface of entries ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          urls.add(`wss://${iface.address}:${currentPort}`);
        }
      }
    }
  }
  return [...urls];
}

function clientIp(req: { socket: { remoteAddress?: string } }): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function rateOk(ip: string): boolean {
  const now = Date.now();
  // Opportunistically drop stale buckets so the map cannot grow unbounded.
  if (rate.size > 4096) {
    for (const [key, bucket] of rate) {
      if (bucket.resetAt < now) rate.delete(key);
    }
  }
  const bucket = rate.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rate.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 60;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function parseMessage(raw: RawData): unknown {
  const text = raw.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('message too large');
  }
  return JSON.parse(text) as unknown;
}

function command(raw: unknown): { id?: string; type: string; [key: string]: unknown } {
  if (!raw || typeof raw !== 'object') throw new Error('invalid message');
  const msg = raw as { id?: unknown; type?: unknown; [key: string]: unknown };
  if (typeof msg.type !== 'string') throw new Error('missing type');
  const out: { id?: string; type: string; [key: string]: unknown } = {
    type: msg.type,
  };
  for (const [key, value] of Object.entries(msg)) {
    if (key !== 'id' && key !== 'type') out[key] = value;
  }
  if (typeof msg.id === 'string') out.id = msg.id;
  return out;
}

function remoteCaller(scope: ProjectExecutionScope) {
  return { role: 'user' as const, scope };
}

function sessionIdOf(
  ref: unknown,
  scope: ProjectExecutionScope,
  action: 'read' | 'write' | 'close',
): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) {
    throw new Error('invalid paneId');
  }
  const pane = getPaneAuthzInfo(ref);
  if (!pane?.sessionId) throw new Error('pane/session not found');
  const decision = authorizePaneAccess(remoteCaller(scope), pane, action);
  if (!decision.allow) throw new Error(`not authorized: ${decision.reason}`);
  return pane.sessionId;
}

async function handleAuthedMessage(
  msg: ReturnType<typeof command>,
  scope: ProjectExecutionScope,
) {
  switch (msg.type) {
    case 'panes.list':
      return listVisiblePaneSnapshots(remoteCaller(scope));
    case 'pane.read': {
      const sessionId = sessionIdOf(msg.paneId, scope, 'read');
      const output = readSessionOutput(sessionId, Number(msg.lines) || 120);
      // Production path: frame terminal output with ORCA terminal-stream-protocol
      // so remote/mobile clients can reconnect with resumeFromSeq.
      const stream = encodeRemoteTerminalOutput(sessionId, output);
      return { output, stream };
    }
    case 'pane.input': {
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data || data.length > 8192) throw new Error('invalid input');
      const text = msg.submit === false ? data : `${data}\n`;
      const sessionId = sessionIdOf(msg.paneId, scope, 'write');
      const ok = orchWriteSession(sessionId, text);
      // Keep stream session alive for resume; optional echo frame for clients
      // that consume binary terminal-stream-protocol over JSON transport.
      const stream = encodeRemoteTerminalOutput(sessionId, '');
      return { ok, stream };
    }
    case 'pane.stream.open': {
      const sessionId = sessionIdOf(msg.paneId, scope, 'read');
      return openRemoteTerminalStream(sessionId);
    }
    case 'pane.stream.frame': {
      const sessionId = sessionIdOf(msg.paneId, scope, 'write');
      const frameBase64 =
        typeof msg.frameBase64 === 'string' ? msg.frameBase64 : '';
      if (!frameBase64 || frameBase64.length > 96_000) {
        throw new Error('invalid stream frame');
      }
      const received = receiveRemoteTerminalFrame(sessionId, frameBase64);
      if (
        received.frame.opcode === TerminalStreamOpcode.Input &&
        received.text
      ) {
        if (received.text.length > 8192) throw new Error('invalid input');
        return {
          ok: orchWriteSession(sessionId, received.text),
          resumeFromSeq: received.resumeFromSeq,
          opcode: received.frame.opcode,
        };
      }
      return {
        ok: true,
        resumeFromSeq: received.resumeFromSeq,
        opcode: received.frame.opcode,
      };
    }
    case 'pane.resize': {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 3) {
        throw new Error('invalid size');
      }
      return {
        ok: orchResizeSession(
          sessionIdOf(msg.paneId, scope, 'write'),
          cols,
          rows,
        ),
      };
    }
    case 'pane.close': {
      if (typeof msg.paneId !== 'string' || msg.paneId.length > 128) {
        throw new Error('invalid paneId');
      }
      const pane = getPaneAuthzInfo(msg.paneId);
      if (!pane) throw new Error('pane not found');
      const decision = authorizePaneAccess(remoteCaller(scope), pane, 'close');
      if (!decision.allow) throw new Error(`not authorized: ${decision.reason}`);
      return { ok: requestPaneClose(pane.paneId) };
    }
    case 'mission.list':
      return getProjectDomainStores(scope).missions.list();
    case 'status':
      return redactRemoteBridgeSecrets(getRemoteBridgeInfo(scope));
    default:
      throw new Error(`unknown command: ${msg.type}`);
  }
}

function onConnection(ws: WebSocket, req: IncomingMessage) {
  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, 'too many connections');
    return;
  }
  clients.add(ws);
  const ip = clientIp(req);
  // Reap sockets that connect but never authenticate — they otherwise pin a
  // slot and file descriptors indefinitely.
  const unauthTimer = setTimeout(() => {
    if (!authenticatedClients.has(ws)) ws.close(1008, 'auth timeout');
  }, UNAUTH_TIMEOUT_MS);
  ws.on('close', () => {
    clearTimeout(unauthTimer);
    clearAuthenticatedClient(ws);
    clients.delete(ws);
  });
  // A protocol error (e.g. an oversized frame rejected by maxPayload) emits
  // 'error' on the socket; without this listener Node would rethrow it as an
  // uncaught exception and take down the whole main process.
  ws.on('error', () => {
    try {
      ws.close(1009, 'protocol error');
    } catch {
      // Socket already gone.
    }
  });
  ws.on('message', async (raw) => {
    let parsed: unknown;
    try {
      parsed = parseMessage(raw);
    } catch (err) {
      send(ws, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const id =
      typeof (parsed as { id?: unknown }).id === 'string'
        ? (parsed as { id: string }).id
        : undefined;
    try {
      if (!rateOk(ip)) throw new Error('rate limited');
      const msg = command(parsed);
      if (msg.type === 'ping') {
        send(ws, { id: msg.id, ok: true, result: { pong: true } });
        return;
      }
      if (msg.type === 'pair') {
        const scope = activeBridgeScope;
        if (!scope) throw new Error('bridge project scope is unavailable');
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        const current = pairingCode();
        const supplied = Buffer.from(code);
        const expected = Buffer.from(current.code);
        const match =
          supplied.length === expected.length &&
          crypto.timingSafeEqual(supplied, expected) &&
          Date.now() <= current.expiresAt;
        if (!match) {
          pairingFailures += 1;
          if (pairingFailures >= MAX_PAIRING_FAILURES) pairing = makePairing();
          throw new Error('invalid pairing code');
        }
        const issued = issueToken(scope);
        authenticateClient(ws, issued.record, scope);
        clearTimeout(unauthTimer);
        pairing = makePairing();
        send(ws, {
          id: msg.id,
          ok: true,
          result: { token: issued.token, expiresAt: issued.expiresAt },
        });
        return;
      }
      if (msg.type === 'auth') {
        const scope = activeBridgeScope;
        if (!scope) throw new Error('bridge project scope is unavailable');
        const token = typeof msg.token === 'string' ? msg.token : '';
        const record = findValidToken(token, scope);
        if (!record) throw new Error('invalid token');
        authenticateClient(ws, record, scope);
        clearTimeout(unauthTimer);
        send(ws, { id: msg.id, ok: true, result: { ok: true } });
        return;
      }
      if (!isClientAuthenticated(ws)) throw new Error('auth required');
      const authenticated = authenticatedClients.get(ws);
      if (!authenticated) throw new Error('auth required');
      const result = await handleAuthedMessage(msg, authenticated.scope);
      send(ws, { id: msg.id, ok: true, result });
    } catch (err) {
      send(ws, {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Serve o thin client mobile na raiz (GET /). Auth continua no WebSocket
 * (pareamento por código → token); a página é só o cliente. Qualquer outra
 * rota é 404 — nenhum estado é exposto por HTTP.
 */
function serveClientPage(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Sem inline eval; scripts/estilos inline próprios da página; conexão só
      // ao mesmo host (o WSS da bridge).
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src wss: 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(REMOTE_CLIENT_HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

export async function startRemoteBridge(
  req: RemoteBridgeStartRequest,
  scope: ProjectExecutionScope,
): Promise<RemoteBridgeInfo> {
  if (!scope) throw new Error('remote bridge requires a project scope');
  if (server && port) {
    assertBridgeScope(scope);
    return getRemoteBridgeInfo(scope);
  }
  activeBridgeScope = Object.freeze({ ...scope });
  const tls = await ensureTls();
  // Default seguro: só localhost. Expor na LAN (0.0.0.0/::) exige pedido
  // explícito do usuário — a bridge controla PTYs reais.
  const host = req.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server = https.createServer({ key: tls.key, cert: tls.cert }, serveClientPage);
    wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });
    wss.on('connection', onConnection);
    wss.on('error', (err) => console.warn('[remote-bridge] wss error:', err));
    server.once('error', reject);
    server.listen(req.port ?? 0, host, () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') port = addr.port;
      boundHost = host;
      resolve();
    });
  });
  return getRemoteBridgeInfo(scope);
}

export function stopRemoteBridge(scope?: ProjectExecutionScope): RemoteBridgeInfo {
  clearRemoteTerminalStreams();
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  for (const client of clients) client.close(1001, 'bridge stopped');
  clients.clear();
  clearAllAuthenticatedClients();
  rate.clear();
  wss?.close();
  server?.close();
  wss = null;
  server = null;
  port = null;
  boundHost = null;
  pairing = makePairing();
  activeBridgeScope = null;
  return getRemoteBridgeInfo();
}

export function rotateRemotePairing(scope?: ProjectExecutionScope): RemoteBridgeInfo {
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  pairing = makePairing();
  return getRemoteBridgeInfo(scope);
}

export function revokeRemoteTokens(scope?: ProjectExecutionScope): RemoteBridgeInfo {
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  const target = scope ?? activeBridgeScope;
  writeTokens(
    target
      ? readTokens().filter(
          (token) =>
            token.projectId !== target.projectId ||
            token.checkoutId !== target.checkoutId,
        )
      : [],
  );
  closeAllAuthenticatedClients('tokens revoked');
  return getRemoteBridgeInfo(scope);
}

export type RemoteBridgeRedactedInfo = Omit<
  RemoteBridgeInfo,
  'pairingCode' | 'pairingExpiresAt'
>;

export function redactRemoteBridgeSecrets(
  info: RemoteBridgeInfo,
): RemoteBridgeRedactedInfo {
  const {
    pairingCode: _pairingCode,
    pairingExpiresAt: _pairingExpiresAt,
    ...safeInfo
  } = info;
  return safeInfo;
}

function sameScopeCoordinates(
  left: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  right: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): boolean {
  return (
    left.projectId === right.projectId && left.checkoutId === right.checkoutId
  );
}

function assertBridgeScope(scope: ProjectExecutionScope): void {
  if (!activeBridgeScope || !sameScopeCoordinates(activeBridgeScope, scope)) {
    throw new Error('remote bridge belongs to another project checkout');
  }
}

export function getRemoteBridgeInfo(
  scope?: ProjectExecutionScope,
): RemoteBridgeInfo {
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  const current = pairingCode();
  const tokenScope = scope ?? activeBridgeScope;
  return {
    running: Boolean(server && port),
    port: port ?? undefined,
    urls: port ? localUrls(port) : [],
    pairingCode: current.code,
    pairingExpiresAt: current.expiresAt,
    tokenCount: tokenScope
      ? readTokens().filter((token) =>
          sameScopeCoordinates(token, tokenScope),
        ).length
      : 0,
    clientCount: clients.size,
    certFingerprint: tlsRecord?.fingerprint,
  };
}
