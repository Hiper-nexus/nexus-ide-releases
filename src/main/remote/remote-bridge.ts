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
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;

let server: https.Server | null = null;
let wss: WebSocketServer | null = null;
let port: number | null = null;
let tlsRecord: TlsRecord | null = null;
let pairing = makePairing();
const clients = new Set<WebSocket>();
const authed = new WeakSet<WebSocket>();
const rate = new Map<string, { count: number; resetAt: number }>();

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}

function writePrivate(file: string, value: unknown): void {
  ensureRoot();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems that do not preserve POSIX mode.
  }
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makePairing(): { code: string; expiresAt: number } {
  return {
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}

function pairingCode(): { code: string; expiresAt: number } {
  if (Date.now() >= pairing.expiresAt) pairing = makePairing();
  return pairing;
}

function readTokens(): TokenRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as TokenFile;
    return (raw.tokens ?? []).filter((token) => token.expiresAt > Date.now());
  } catch {
    return [];
  }
}

function writeTokens(tokens: TokenRecord[]): void {
  writePrivate(TOKENS_FILE, { tokens });
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
  const hash = sha256Hex(token);
  let changed = false;
  const tokens = readTokens();
  const valid = tokens.some((record) => {
    const left = Buffer.from(record.hash, 'hex');
    const right = Buffer.from(hash, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  if (tokens.length !== readRawTokenCount()) changed = true;
  if (changed) writeTokens(tokens);
  return valid;
}

function readRawTokenCount(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as TokenFile;
    return raw.tokens?.length ?? 0;
  } catch {
    return 0;
  }
}

async function ensureTls(): Promise<TlsRecord> {
  if (tlsRecord) return tlsRecord;
  try {
    const raw = JSON.parse(fs.readFileSync(TLS_FILE, 'utf8')) as TlsRecord;
    if (raw.key && raw.cert && raw.fingerprint) {
      tlsRecord = raw;
      return raw;
    }
  } catch {
    // Generate below.
  }
  const pems = await generate(
    [{ name: 'commonName', value: 'Nexus Remote Bridge' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    },
  );
  const record = {
    key: pems.private,
    cert: pems.cert,
    fingerprint: pems.fingerprint,
  };
  writePrivate(TLS_FILE, record);
  tlsRecord = record;
  return record;
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
      if (typeof msg.paneId !== 'string') throw new Error('invalid paneId');
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
  clients.add(ws);
  const ip = clientIp(req);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (raw) => {
    const id = (() => {
      try {
        const parsed = parseMessage(raw);
        return typeof (parsed as { id?: unknown }).id === 'string'
          ? (parsed as { id: string }).id
          : undefined;
      } catch {
        return undefined;
      }
    })();
    try {
      if (!rateOk(ip)) throw new Error('rate limited');
      const msg = command(parseMessage(raw));
      if (msg.type === 'ping') {
        send(ws, { id: msg.id, ok: true, result: { pong: true } });
        return;
      }
      if (msg.type === 'pair') {
        const code = typeof msg.code === 'string' ? msg.code.trim() : '';
        const current = pairingCode();
        if (code !== current.code || Date.now() > current.expiresAt) {
          throw new Error('invalid pairing code');
        }
        const issued = issueToken();
        authed.add(ws);
        pairing = makePairing();
        send(ws, { id: msg.id, ok: true, result: issued });
        return;
      }
      if (msg.type === 'auth') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        if (!tokenValid(token)) throw new Error('invalid token');
        authed.add(ws);
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
  await new Promise<void>((resolve, reject) => {
    server = https.createServer({ key: tls.key, cert: tls.cert });
    wss = new WebSocketServer({ server });
    wss.on('connection', onConnection);
    server.once('error', reject);
    server.listen(req.port ?? 0, '0.0.0.0', () => {
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
  wss?.close();
  server?.close();
  wss = null;
  server = null;
  port = null;
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
