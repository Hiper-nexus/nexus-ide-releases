import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type {
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
} from '../../shared/remote-types';
import { writeJsonAtomic } from '../util/atomic-write';
import { listMissions } from '../orch/mission-store';
import {
  findPane,
  listPaneSnapshots,
  readSessionOutput,
  requestPaneClose,
} from '../orch/pane-registry';
import {
  orchResizeSession,
  orchWriteSession,
} from '../pty/pty-manager';

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
}

interface TokenFile {
  tokens: TokenRecord[];
}

const ROOT = path.join(os.homedir(), '.nexus', 'remote-bridge');
const TLS_FILE = path.join(ROOT, 'tls.json');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

let server: https.Server | null = null;
let wss: WebSocketServer | null = null;
let port: number | null = null;
let tlsRecord: TlsRecord | null = null;
let pairingFailures = 0;
let pairing = makePairing();
let tokenCache: TokenRecord[] | null = null;
const clients = new Set<WebSocket>();
let authed = new WeakSet<WebSocket>();
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
    tokenCache = raw.tokens ?? [];
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

function issueToken(): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const tokens = readTokens();
  tokens.push({
    id: crypto.randomUUID(),
    hash: sha256Hex(token),
    createdAt: Date.now(),
    expiresAt,
  });
  writeTokens(tokens);
  return { token, expiresAt };
}

function tokenValid(token: string): boolean {
  if (!token) return false;
  const hash = sha256Hex(token);
  const right = Buffer.from(hash, 'hex');
  return readTokens().some((record) => {
    const left = Buffer.from(record.hash, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
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
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const iface of entries ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.add(`wss://${iface.address}:${currentPort}`);
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

function sessionIdOf(ref: unknown): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) {
    throw new Error('invalid paneId');
  }
  const pane = findPane(ref);
  if (!pane?.sessionId) throw new Error('pane/session not found');
  return pane.sessionId;
}

async function handleAuthedMessage(msg: ReturnType<typeof command>) {
  switch (msg.type) {
    case 'panes.list':
      return listPaneSnapshots();
    case 'pane.read':
      return {
        output: readSessionOutput(sessionIdOf(msg.paneId), Number(msg.lines) || 120),
      };
    case 'pane.input': {
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data || data.length > 8192) throw new Error('invalid input');
      const text = msg.submit === false ? data : `${data}\n`;
      return { ok: orchWriteSession(sessionIdOf(msg.paneId), text) };
    }
    case 'pane.resize': {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 3) {
        throw new Error('invalid size');
      }
      return { ok: orchResizeSession(sessionIdOf(msg.paneId), cols, rows) };
    }
    case 'pane.close': {
      if (typeof msg.paneId !== 'string' || msg.paneId.length > 128) {
        throw new Error('invalid paneId');
      }
      const pane = findPane(msg.paneId);
      if (!pane) throw new Error('pane not found');
      return { ok: requestPaneClose(pane.paneId) };
    }
    case 'mission.list':
      return listMissions();
    case 'status':
      return getRemoteBridgeInfo();
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
    if (!authed.has(ws)) ws.close(1008, 'auth timeout');
  }, UNAUTH_TIMEOUT_MS);
  ws.on('close', () => {
    clearTimeout(unauthTimer);
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
        const issued = issueToken();
        authed.add(ws);
        clearTimeout(unauthTimer);
        pairing = makePairing();
        send(ws, { id: msg.id, ok: true, result: issued });
        return;
      }
      if (msg.type === 'auth') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        if (!tokenValid(token)) throw new Error('invalid token');
        authed.add(ws);
        clearTimeout(unauthTimer);
        send(ws, { id: msg.id, ok: true, result: { ok: true } });
        return;
      }
      if (!authed.has(ws)) throw new Error('auth required');
      const result = await handleAuthedMessage(msg);
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

export async function startRemoteBridge(
  req: RemoteBridgeStartRequest = {},
): Promise<RemoteBridgeInfo> {
  if (server && port) return getRemoteBridgeInfo();
  const tls = await ensureTls();
  const host = req.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server = https.createServer({ key: tls.key, cert: tls.cert });
    wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });
    wss.on('connection', onConnection);
    wss.on('error', (err) => console.warn('[remote-bridge] wss error:', err));
    server.once('error', reject);
    server.listen(req.port ?? 0, host, () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') port = addr.port;
      resolve();
    });
  });
  return getRemoteBridgeInfo();
}

export function stopRemoteBridge(): RemoteBridgeInfo {
  for (const client of clients) client.close(1001, 'bridge stopped');
  clients.clear();
  authed = new WeakSet<WebSocket>();
  rate.clear();
  wss?.close();
  server?.close();
  wss = null;
  server = null;
  port = null;
  pairing = makePairing();
  return getRemoteBridgeInfo();
}

export function rotateRemotePairing(): RemoteBridgeInfo {
  pairing = makePairing();
  return getRemoteBridgeInfo();
}

export function revokeRemoteTokens(): RemoteBridgeInfo {
  writeTokens([]);
  return getRemoteBridgeInfo();
}

export function getRemoteBridgeInfo(): RemoteBridgeInfo {
  const current = pairingCode();
  return {
    running: Boolean(server && port),
    port: port ?? undefined,
    urls: port ? localUrls(port) : [],
    pairingCode: current.code,
    pairingExpiresAt: current.expiresAt,
    tokenCount: readTokens().length,
    clientCount: clients.size,
    certFingerprint: tlsRecord?.fingerprint,
  };
}
