import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type {
  ApprovalOption,
  ApprovalProvider,
  ApprovalResponseCapability,
} from '../../shared/approval-decision';
import { HookApprovalRespondParams } from '../../shared/rpc-contract/structured-agent-session-params';
import {
  approvalBroker,
  registerRemoteApprovalResponder,
  type ApprovalRespondResult,
} from '../agent-hooks/approval-broker';
import type {
  RemoteBridgeEndpoint,
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
} from '../../shared/remote-types';
// MOB-12 (início): escopos por aparelho.
import {
  REMOTE_DEVICE_SCOPES,
  type RemoteDeviceScope,
} from '../../shared/remote-types';
import { authorizeRemoteDeviceRequest } from './device-scopes';
import {
  listRemoteDeviceTokens,
  remoteDeviceTokenScopes,
  setRemoteDeviceTokenScopes,
} from './remote-device-token-store';
// MOB-12 (fim)
import type { ProjectExecutionScope } from '../../shared/types';
import { writeJsonAtomic } from '../util/atomic-write';
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
  peekPushCursor,
  subscribeEncodedSessionOutput,
} from './remote-output-bus';
import {
  clearRemoteTerminalStreams,
  encodeRemoteTerminalOutput,
  openRemoteTerminalStream,
  receiveRemoteTerminalFrame,
} from './remote-terminal-streams';
import { TerminalStreamOpcode } from '../../shared/terminal-stream-protocol';
import {
  authorizeRemotePaneInput,
  authorizeMobileRpc,
  mobileRpcKindForBridgeType,
} from './mobile-companion-policy';
import { requestRemoteDesktopConfirmation } from './remote-desktop-confirmation';
import {
  remoteFilesList,
  remoteFilesRead,
  remoteGitDiff,
  remoteGitStatus,
  resolveRemotePaneWorkspace,
} from './remote-workspace-rpc';
import { createRemoteInputDedup, remoteInputMessageId } from './remote-input-dedup';
import {
  parseRemoteDeviceIdentity,
  verifyRemoteDeviceSignature,
} from './remote-device-authority';
import {
  countRemoteDeviceTokens,
  findRemoteDeviceToken,
  issueRemoteDeviceToken,
  remoteDeviceTokenExists,
  revokeRemoteDeviceTokens,
  type RemoteDeviceTokenRecord,
} from './remote-device-token-store';
import { serveRemoteClientPage } from './remote-client-server';
import {
  cleanupOrphanRemoteBridgeTailscale,
  detectRemoteBridgeTailscale,
  publishRemoteBridgeOnTailnet,
  unpublishRemoteBridgeFromTailnet,
  type RemoteBridgeTailscaleState,
} from './remote-bridge-tailscale';
import { isTailscaleIpv4Address } from './tailscale';

interface TlsRecord {
  key: string;
  cert: string;
  fingerprint: string;
  hosts: string[];
}

interface AuthenticatedClient {
  tokenId: string;
  deviceId: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  scope: ProjectExecutionScope;
}

interface AuthenticationChallenge {
  id: string;
  challenge: string;
  tokenId: string;
  deviceId: string;
  expiresAt: number;
}

const ROOT = path.join(os.homedir(), '.nexus', 'remote-bridge');
const TLS_FILE = path.join(ROOT, 'tls.json');
const PAIRING_TTL_MS = 5 * 60 * 1000;
const AUTH_CHALLENGE_TTL_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS = 16;
const UNAUTH_TIMEOUT_MS = 15_000;
// Bound the number of guesses per client IP. Exceeding it locks that IP out for
// a cooldown instead of rotating the shared code (L16): an unauthenticated peer
// must never be able to invalidate the code a legitimate user is scanning.
const MAX_PAIRING_FAILURES = 8;
const PAIRING_LOCKOUT_MS = 60_000;
const RATE_LIMIT_PER_MINUTE = 60;
// Atrás do Tailscale Serve todo cliente chega por loopback, então o IP do
// socket não distingue ninguém. A pré-autenticação conta por conexão; as
// tentativas de pareamento contam por PARTIÇÃO — o peer do tailnet que o
// próprio Serve carimba (servePeerPartition) — com um teto global maior como
// rede. Loopback sem partição (desktop local, Serve que não é desta bridge)
// divide um balde próprio. Força bruta do código de 8 caracteres: ≤ 240/min
// × 5 min de validade ≈ 1200 palpites em ~1,1e12.
const PEER_PAIR_ATTEMPTS_PER_MINUTE = 10;
const LOCAL_PAIR_ATTEMPTS_PER_MINUTE = 30;
const PROXY_PAIR_ATTEMPTS_PER_MINUTE = 240;
const PROXY_PAIR_RATE_KEY = 'pre:proxy:pair';
const LOCAL_PAIR_RATE_KEY = 'pre:proxy:pair:local';
const MAX_PAIRING_FAILURE_KEYS = 4096;
// Unambiguous alphabet (no 0/O/1/I/L) over 8 chars ≈ 32^8 ≈ 1.1e12 keyspace.
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_LEN = 8;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let server: https.Server | null = null;
let wss: WebSocketServer | null = null;
let port: number | null = null;
let boundHost: string | null = null;
let tlsRecord: TlsRecord | null = null;
// Chave: IP direto (LAN) ou `pre:conn:<n>` para conexões via loopback/proxy.
const pairingFailuresByIp = new Map<
  string,
  { count: number; lockedUntil: number }
>();
let pairing = makePairing();
let activeBridgeScope: ProjectExecutionScope | null = null;
const clients = new Set<WebSocket>();
const authenticatedClients = new Map<WebSocket, AuthenticatedClient>();
const authenticationChallenges = new Map<WebSocket, AuthenticationChallenge>();
const rate = new Map<string, { count: number; resetAt: number }>();
// Tailscale Serve: estado do handler desta bridge + fila que serializa todo
// spawn da CLI (publicar, despublicar, limpar órfão) para que um stop no meio
// de um start nunca intercale `serve --bg` e `serve off` fora de ordem.
let bridgeTailscale: RemoteBridgeTailscaleState | null = null;
let bridgeGeneration = 0;
let tailscaleQueue: Promise<unknown> = Promise.resolve();
let connectionSeq = 0;
// Consulta do Serve que falhou = dono desconhecido: nada é desligado e a
// tentativa se repete — 5 s/30 s/2 min e depois a cada 10 min, sem desistir,
// enquanto o handler pode ser nosso (stop) ou houver marcador de pid morto
// (boot). Um handler que aponta para uma porta efêmera fechada continuaria
// publicado para o tailnet inteiro.
const TAILSCALE_RETRY_MS = [5_000, 30_000, 120_000] as const;
const TAILSCALE_RETRY_STEADY_MS = 10 * 60_000;
const tailscaleRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let orphanRetryTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueTailscale<T>(task: () => Promise<T>): Promise<T> {
  const run = tailscaleQueue.then(task, task);
  tailscaleQueue = run.catch(() => undefined);
  return run;
}

function tailscaleRetryDelay(attempt: number): number {
  return TAILSCALE_RETRY_MS[attempt] ?? TAILSCALE_RETRY_STEADY_MS;
}

function scheduleTailscaleRetry(attempt: number, run: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    tailscaleRetryTimers.delete(timer);
    run();
  }, tailscaleRetryDelay(attempt));
  timer.unref?.();
  tailscaleRetryTimers.add(timer);
  return timer;
}

function scheduleUnpublish(target: string, servePort: number, attempt = 0): void {
  void enqueueTailscale(async () => {
    // Conferido na VEZ da tarefa (não ao armar o timer): um republish no mesmo
    // alvo (porta fixa) que entrou na fila antes desta tarefa já é da bridge
    // viva, e `serve off` derrubaria a bridge em uso.
    if (bridgeTailscale?.target === target) return 'superseded' as const;
    return unpublishRemoteBridgeFromTailnet(target, servePort);
  }).then(
    (outcome) => {
      if (outcome !== 'unknown') return;
      scheduleTailscaleRetry(attempt, () => scheduleUnpublish(target, servePort, attempt + 1));
    },
    () => undefined,
  );
}

function runOrphanCleanup(attempt: number): Promise<void> {
  return enqueueTailscale(() =>
    cleanupOrphanRemoteBridgeTailscale(bridgeTailscale?.target ?? null),
  )
    .catch(() => 'unknown' as const)
    .then((outcome) => {
      // Para quando limpou, quando o marcador sumiu ou o dono está vivo.
      if (outcome !== 'unknown') return;
      if (orphanRetryTimer) clearTimeout(orphanRetryTimer);
      orphanRetryTimer = scheduleTailscaleRetry(attempt, () => {
        orphanRetryTimer = null;
        void runOrphanCleanup(attempt + 1);
      });
    });
}

function releaseBridgeTailscale(): void {
  const current = bridgeTailscale;
  bridgeTailscale = null;
  if (!current?.target) return;
  scheduleUnpublish(current.target, current.servePort);
}

/** Aplica o pedido explícito de start: publica (ou despublica) no tailnet. */
async function applyBridgeTailscale(enabled: boolean): Promise<void> {
  if (!enabled) {
    releaseBridgeTailscale();
    return;
  }
  const localPort = port;
  if (!localPort || bridgeTailscale?.target) return;
  const generation = bridgeGeneration;
  const localHost = boundHost === '::1' ? '[::1]' : '127.0.0.1';
  await enqueueTailscale(async () => {
    const published = await publishRemoteBridgeOnTailnet({ localPort, localHost });
    if (generation !== bridgeGeneration || port !== localPort) {
      // A bridge parou enquanto o Serve era configurado: desfaz o que entrou.
      if (published.target) scheduleUnpublish(published.target, published.servePort);
      return;
    }
    // Dentro da tarefa da fila: qualquer unpublish/limpeza enfileirado depois
    // já enxerga o handler como da bridge viva.
    bridgeTailscale = published;
  });
}

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < PAIRING_LEN; i += 1) {
    out += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return out;
}

// MOB-12: o código carrega os escopos que concede ao aparelho que o usar.
type PairingGrant = { code: string; expiresAt: number; scopes: readonly RemoteDeviceScope[] };

function makePairing(
  scopes: readonly RemoteDeviceScope[] = REMOTE_DEVICE_SCOPES,
): PairingGrant {
  pairingFailuresByIp.clear();
  return { code: randomCode(), expiresAt: Date.now() + PAIRING_TTL_MS, scopes: [...scopes] };
}

function invalidatePairing(): void {
  pairingFailuresByIp.clear();
  pairing = { code: '', expiresAt: 0, scopes: [] };
}

/** Ms remaining on a pairing lockout (IP or proxied connection), or 0. */
function pairingLockRemaining(key: string): number {
  const entry = pairingFailuresByIp.get(key);
  if (!entry) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

/** Record a failed pairing attempt for a key and lock it out past the cap. */
function recordPairingFailure(key: string): void {
  if (pairingFailuresByIp.size >= MAX_PAIRING_FAILURE_KEYS && !pairingFailuresByIp.has(key)) {
    // Partições sobrevivem ao close: poda as que não estão bloqueadas agora.
    const now = Date.now();
    for (const [stale, entry] of pairingFailuresByIp) {
      if (entry.lockedUntil <= now) pairingFailuresByIp.delete(stale);
    }
  }
  const entry = pairingFailuresByIp.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_PAIRING_FAILURES) {
    entry.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS;
  }
  pairingFailuresByIp.set(key, entry);
}

function pairingCode(): PairingGrant {
  if (pairing.code && pairing.expiresAt <= Date.now()) invalidatePairing();
  return pairing;
}

function clearAuthenticatedClient(ws: WebSocket): void {
  const current = authenticatedClients.get(ws);
  if (current) clearTimeout(current.expiryTimer);
  authenticatedClients.delete(ws);
  authenticationChallenges.delete(ws);
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
  deviceId: string,
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
    scheduleExpiry(ws, tokenId, deviceId, expiresAt, current.scope);
  }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  expiryTimer.unref?.();
  authenticatedClients.set(ws, {
    tokenId,
    deviceId,
    expiresAt,
    expiryTimer,
    scope: Object.freeze({ ...scope }),
  });
}

function authenticateClient(
  ws: WebSocket,
  token: RemoteDeviceTokenRecord,
  scope: ProjectExecutionScope,
): void {
  clearAuthenticatedClient(ws);
  scheduleExpiry(ws, token.id, token.deviceId, token.expiresAt, scope);
}

function isClientAuthenticated(ws: WebSocket): boolean {
  const current = authenticatedClients.get(ws);
  if (!current) return false;
  if (current.expiresAt <= Date.now()) {
    closeAuthenticatedClient(ws, 'token expired');
    return false;
  }
  const tokenStillExists = remoteDeviceTokenExists({
    tokenId: current.tokenId,
    deviceId: current.deviceId,
    scope: current.scope,
  });
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

// MOB-12 (início): escopo vivo do aparelho deste socket (lido do grant a cada
// uso — a edição no desktop vale no próximo pedido/push). Pushes com dados de
// pane (stream, atividade) conferem `read` aqui antes de enviar.
function clientHasScope(ws: WebSocket, scope: RemoteDeviceScope): boolean {
  const client = authenticatedClients.get(ws);
  return client !== undefined && remoteDeviceTokenScopes(client.tokenId).includes(scope);
}
// MOB-12 (fim)

// ---------------------------------------------------------------------------
// pane.stream push — real-time terminal output for subscribed companions.
// The thin client used to poll pane.read every 2.5 s while the binary stream
// existed server-side unused; pushing closes that gap. Frames come from the
// shared remote-output-bus (ONE encode per chunk, shared with the companion
// relay) so every consumer sees the same seq domain as pane.read — a client
// that misses a push (backpressure skip, reconnect) sees a genuine seq gap
// and heals via pane.read.
// ---------------------------------------------------------------------------

const STREAM_PUSH_MAX_BUFFERED_BYTES = 256 * 1024;

const streamSubscribers = new Map<string, Set<WebSocket>>();
let sessionDataTapDispose: (() => void) | null = null;

function subscribePaneStream(ws: WebSocket, sessionId: string): void {
  // Uma inscrição ativa por socket: o thin client vê um pane por vez, e sem
  // esta troca server-side um pane ruidoso já visitado continuaria enchendo
  // o buffer do socket para sempre (o close explícito do cliente é cortesia,
  // não garantia).
  dropStreamSubscriber(ws);
  let set = streamSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    streamSubscribers.set(sessionId, set);
  }
  set.add(ws);
  ensureSessionDataTap();
}

function unsubscribePaneStream(ws: WebSocket, sessionId?: string): void {
  if (sessionId) {
    const set = streamSubscribers.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) streamSubscribers.delete(sessionId);
    }
    return;
  }
  dropStreamSubscriber(ws);
}

function dropStreamSubscriber(ws: WebSocket): void {
  for (const [sessionId, set] of streamSubscribers) {
    set.delete(ws);
    if (set.size === 0) streamSubscribers.delete(sessionId);
  }
}

function clearStreamSubscriptions(): void {
  streamSubscribers.clear();
  sessionDataTapDispose?.();
  sessionDataTapDispose = null;
}

function ensureSessionDataTap(): void {
  if (sessionDataTapDispose) return;
  sessionDataTapDispose = subscribeEncodedSessionOutput({
    wants: (sessionId) => (streamSubscribers.get(sessionId)?.size ?? 0) > 0,
    deliver: (sessionId, encoded) => {
      const subscribers = streamSubscribers.get(sessionId);
      if (!subscribers) return;
      // isClientAuthenticated may close/mutate the set — iterate a copy.
      for (const ws of [...subscribers]) {
        if (!isClientAuthenticated(ws) || !clientHasScope(ws, 'read')) {
          // MOB-12: sem `read` (escopo editado no desktop) o push para.
          subscribers.delete(ws);
          continue;
        }
        // Backpressure fail-safe: skipping creates a seq gap the client
        // detects and heals with a pane.read resync — never unbounded buffer.
        if (ws.bufferedAmount > STREAM_PUSH_MAX_BUFFERED_BYTES) continue;
        send(ws, {
          type: 'pane.stream.data',
          streamId: encoded.streamId,
          // Cursor dedicado de push: encodes de resposta (pane.read/input)
          // avançam o seq do frame mas NÃO este cursor — sem gaps falsos.
          seq: encoded.pushSeq,
          frameBase64: encoded.frameBase64,
        });
      }
    },
  });
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
    return crypto.createHash('sha256').update(certPem).digest('hex');
  }
}

function localEndpoints(currentPort: number): RemoteBridgeEndpoint[] {
  const endpoints: RemoteBridgeEndpoint[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: RemoteBridgeEndpoint['label']) => {
    if (seen.has(url)) return;
    seen.add(url);
    endpoints.push({ url, label });
  };
  // Tailscale Serve primeiro: certificado válido *.ts.net, sem aviso de
  // self-signed, alcançável fora da LAN sem abrir porta.
  const httpsUrl = bridgeTailscale?.info.httpsUrl;
  if (httpsUrl) add(`wss://${new URL(httpsUrl).host}`, 'Tailscale HTTPS');
  add(`wss://127.0.0.1:${currentPort}`, 'Este computador');
  // Só anuncia IPs da LAN quando o bind é wildcard — bound a localhost, essas
  // URLs não funcionariam.
  if (boundHost === '0.0.0.0' || boundHost === '::') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const iface of entries ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          add(
            `wss://${iface.address}:${currentPort}`,
            isTailscaleIpv4Address(iface.address) ? 'Tailscale IP' : 'Rede local',
          );
        }
      }
    }
  }
  return endpoints;
}

function clientIp(req: { socket: { remoteAddress?: string } }): string {
  // Só o socket. Atrás do Tailscale Serve todo cliente chega como loopback;
  // X-Forwarded-For/Tailscale-User-* nunca viram identidade (ver
  // servePeerPartition para o único uso deles).
  return req.socket.remoteAddress ?? 'unknown';
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

/** IP do tailnet: 100.64.0.0/10 ou fd7a:115c:a1e0::/48, em forma canônica. */
function isTailnetPeerAddress(value: string): boolean {
  if (isIPv4(value)) return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && isTailscaleIpv4Address(value);
  return isIPv6(value) && value.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * Chave de PARTIÇÃO do rate limit/lockout de pareamento pré-auth para quem
 * chega pelo Tailscale Serve — nunca identidade, nunca autorização.
 *
 * Por que dá para usar: o proxy do Serve (tailscaled, ipnlocal/serve.go)
 * descarta o X-Forwarded-For de entrada e grava o IP tailnet do peer, e apaga
 * Tailscale-User-* antes de gravar o login do dono do nó (ausente em nó com
 * tag). Um peer do tailnet não escolhe esses valores.
 *
 * Quando vale: SÓ com socket de loopback (é por onde o Serve entrega) E com o
 * Serve publicado por ESTA bridge (sem ele não há proxy, e o cabeçalho só pode
 * ter vindo de um processo local) E com X-Forwarded-For único e do tailnet.
 * LAN direta nunca usa cabeçalho (vale o IP do socket). Um processo local na
 * porta loopback ainda forja tudo: por isso o teto global segue como rede e
 * nada aqui libera acesso — só separa baldes.
 */
function servePeerPartition(req: IncomingMessage, proxied: boolean): string | null {
  if (!proxied || !bridgeTailscale?.target) return null;
  const forwardedFor = singleHeader(req.headers['x-forwarded-for']);
  if (!forwardedFor || !isTailnetPeerAddress(forwardedFor)) return null;
  const login = singleHeader(req.headers['tailscale-user-login']);
  if (login && /^[\x21-\x7e]+$/.test(login)) return `login:${login.toLowerCase()}`;
  return `node:${forwardedFor.toLowerCase()}`;
}

function rateOk(key: string, limit = RATE_LIMIT_PER_MINUTE): boolean {
  const now = Date.now();
  // Opportunistically drop stale buckets so the map cannot grow unbounded.
  if (rate.size > 4096) {
    for (const [key, bucket] of rate) {
      if (bucket.resetAt < now) rate.delete(key);
    }
  }
  const bucket = rate.get(key);
  if (!bucket || bucket.resetAt < now) {
    rate.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
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

// Reenvio do outbox mobile (mesmo messageId) não digita o prompt de novo.
const paneInputDedup = createRemoteInputDedup<boolean>({ isDelivered: (ok) => ok });

// ---------------------------------------------------------------------------
// Aprovação estruturada (PRV-02/MOB-07). O aparelho vê os pedidos pendentes no
// ops.snapshot (só de panes que o escopo dele pode LER), é avisado por push
// `approvals.changed` e responde com `agentSession.respondToApproval` — uma
// DECISÃO entregue ao broker, nunca uma tecla no PTY.
// ---------------------------------------------------------------------------

export type RemoteApproval = {
  readonly requestId: string;
  readonly revision: number;
  readonly paneId: string;
  readonly provider: ApprovalProvider;
  readonly tool: string;
  readonly summary: string;
  readonly options: readonly ApprovalOption[];
  readonly responseCapability: ApprovalResponseCapability;
  readonly expiresAt: number;
};

export type RemoteApprovalResult =
  | ApprovalRespondResult
  | { readonly status: 'rejected'; readonly reason: string };

function remoteApprovalsFor(scope: ProjectExecutionScope): RemoteApproval[] {
  return approvalBroker.list().flatMap((request) => {
    const pane = getPaneAuthzInfo(request.sessionId);
    if (!pane || !authorizePaneAccess(remoteCaller(scope), pane, 'read').allow) return [];
    return [
      {
        requestId: request.requestId,
        revision: request.revision,
        paneId: pane.paneId,
        provider: request.provider,
        tool: request.tool,
        summary: request.summary,
        options: request.options,
        responseCapability: request.responseCapability,
        expiresAt: request.expiresAt,
      },
    ];
  });
}

/** Um cliente autenticado agora, com escrita no pane do pedido, é respondente. */
function remoteBridgeCanRespond(sessionId: string): boolean {
  if (authenticatedClients.size === 0) return false;
  const pane = getPaneAuthzInfo(sessionId);
  if (!pane) return false;
  const now = Date.now();
  for (const client of authenticatedClients.values()) {
    if (client.expiresAt <= now) continue;
    if (
      !remoteDeviceTokenExists({
        tokenId: client.tokenId,
        deviceId: client.deviceId,
        scope: client.scope,
      })
    ) {
      continue;
    }
    // MOB-12: só aparelho com `approve` conta como respondente.
    if (!remoteDeviceTokenScopes(client.tokenId).includes('approve')) continue;
    if (authorizePaneAccess(remoteCaller(client.scope), pane, 'write').allow) return true;
  }
  return false;
}

registerRemoteApprovalResponder(remoteBridgeCanRespond);
approvalBroker.subscribe(() => {
  // Sem dados no push: o cliente relê o ops.snapshot, que aplica a autoridade.
  for (const ws of authenticatedClients.keys()) send(ws, { type: 'approvals.changed' });
});

async function respondToApprovalFromRemote(
  msg: AuthedBridgeCommand,
  scope: ProjectExecutionScope,
  confirmationSessionId: string,
): Promise<RemoteApprovalResult> {
  // Mesmo esquema do contrato RPC (ramo sem envelope de respondToApproval).
  const parsed = HookApprovalRespondParams.safeParse({
    itemId: msg.itemId,
    expectedRevision: msg.expectedRevision,
    optionId: msg.optionId,
  });
  if (!parsed.success) return { status: 'rejected', reason: 'invalid-params' };
  const { itemId, expectedRevision, optionId } = parsed.data;
  // Pedido desconhecido e pane de outro escopo dão a MESMA recusa: o aparelho
  // não descobre se o requestId existe.
  const sessionId = approvalBroker.sessionOf(itemId);
  const pane = sessionId ? getPaneAuthzInfo(sessionId) : null;
  const paneWriteGrant =
    pane !== null && authorizePaneAccess(remoteCaller(scope), pane, 'write').allow;
  const approving = optionId === 'accept' || optionId === 'acceptForSession';
  const decision = authorizeMobileRpc({
    kind: 'approval.respond',
    deviceActive: true, // a mensagem já passou pela autenticação da bridge
    desktopConfirmed: false,
    paneWriteGrant,
    highImpact: approving && approvalBroker.isHighImpact(itemId),
  });
  if (!decision.allowed) return { status: 'rejected', reason: decision.reason };
  if (decision.requiresConfirmation) {
    const request = approvalBroker.list().find((entry) => entry.requestId === itemId);
    const granted = await requestRemoteDesktopConfirmation({
      confirmationSessionId,
      scope,
      toolName: 'remote_approval',
      reason: 'aprovação remota de um comando destrutivo, remoto, de deploy ou publicação',
      args: { command: request?.summary ?? '', tool: request?.tool ?? '', paneId: pane?.paneId ?? '' },
    });
    if (!granted) return { status: 'rejected', reason: 'desktop-confirmation-denied' };
  }
  return approvalBroker.respond({ requestId: itemId, expectedRevision, optionId, source: 'mobile' });
}

/** Shape das mensagens autenticadas aceitas pelo dispatch da bridge. */
export type AuthedBridgeCommand = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

async function confirmDestructiveMobileRpc(
  rpcType: string,
  scope: ProjectExecutionScope,
  confirmationSessionId: string,
): Promise<boolean> {
  return requestRemoteDesktopConfirmation({
    confirmationSessionId,
    scope,
    toolName: rpcType,
    reason: 'operação destrutiva solicitada por dispositivo remoto',
    args: { operation: rpcType },
  });
}

/**
 * Dispatch autenticado da bridge. Exportado para o transporte relay do
 * companion (companion-relay-transport) reutilizar o MESMO caminho de RPC —
 * a mobile-companion-policy continua sendo a autoridade aqui dentro.
 */
export async function handleAuthedMessage(
  msg: AuthedBridgeCommand,
  scope: ProjectExecutionScope,
  // Optional push target: when the caller is a live WS client, pane.stream.open
  // also subscribes it to real-time output pushes. Relay/other callers keep the
  // request/response contract unchanged.
  pushTarget?: WebSocket,
  confirmationSessionId = `remote:${scope.projectId}:${scope.checkoutId}`,
  // MOB-12: escopos do aparelho (WS: lidos do grant a cada pedido). O relay do
  // companion não tem grant por aparelho — o link tem o próprio gate de escrita.
  deviceScopes: readonly RemoteDeviceScope[] = REMOTE_DEVICE_SCOPES,
) {
  // MOB-12 (início): checagem central — tipo desconhecido é recusado (fail
  // closed) e cada comando exige o escopo da tabela de device-scopes.ts,
  // antes de qualquer diálogo, autorização de pane ou escrita.
  const scopeDecision = authorizeRemoteDeviceRequest(msg.type, deviceScopes);
  if (!scopeDecision.allowed) throw new Error(scopeDecision.error);
  const canRead = deviceScopes.includes('read');
  // MOB-12 (fim)
  // PRV-02: a política da aprovação depende do pane do pedido (grant) e do
  // risco do comando, então ela é aplicada lá dentro, antes do broker.
  if (msg.type === 'agentSession.respondToApproval') {
    return respondToApprovalFromRemote(msg, scope, confirmationSessionId);
  }
  // Defesa em profundidade do companion mobile: RPCs modelados pela política
  // passam pelo gate (destrutivos exigem confirmação do DESKTOP via diálogo
  // nativo — nunca um booleano enviado pelo próprio cliente, que seria
  // forjável). mission.complete é sempre negado do mobile.
  const rpcKind = mobileRpcKindForBridgeType(msg.type);
  if (rpcKind) {
    const decision = authorizeMobileRpc({
      kind: rpcKind,
      deviceActive: true, // a mensagem já passou pela autenticação da bridge
      desktopConfirmed: false, // H5: never trust a client-sent boolean
    });
    if (!decision.allowed) {
      // If the RPC was denied only because it needs confirmation, prompt the
      // DESKTOP user with a native (non-forgeable) dialog instead.
      if (decision.reason === 'destructive-confirmation-required') {
        const granted = await confirmDestructiveMobileRpc(
          msg.type,
          scope,
          confirmationSessionId,
        );
        if (!granted) {
          throw new Error('not authorized: destructive operation denied by desktop user');
        }
      } else {
        throw new Error(`not authorized: ${decision.reason}`);
      }
    }
  }
  switch (msg.type) {
    case 'panes.list':
      return canRead ? listVisiblePaneSnapshots(remoteCaller(scope)) : []; // MOB-12
    case 'pane.read': {
      const sessionId = sessionIdOf(msg.paneId, scope, 'read');
      const output = readSessionOutput(sessionId, Number(msg.lines) || 120);
      // Production path: frame terminal output with ORCA terminal-stream-protocol
      // so remote/mobile clients can reconnect with resumeFromSeq.
      const stream = encodeRemoteTerminalOutput(sessionId, output);
      // pushSeq realinha o cursor de push do cliente após a reconciliação.
      return { output, stream: { ...stream, pushSeq: peekPushCursor(sessionId) } };
    }
    case 'pane.input': {
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data || data.length > 8192) throw new Error('invalid input');
      const inputDecision = authorizeRemotePaneInput(data, msg.submit !== false);
      if (!inputDecision.allowed) {
        throw new Error(`not authorized: ${inputDecision.reason}`);
      }
      const messageId = remoteInputMessageId(msg.messageId);
      // Com messageId a autorização vem antes do cache: um reenvio nunca pula
      // a checagem do pane. Sem ele, a ordem original (confirmação primeiro).
      let sessionId = messageId ? sessionIdOf(msg.paneId, scope, 'write') : null;
      const deliverInput = async (): Promise<boolean> => {
        if (inputDecision.requiresDesktopConfirmation) {
          const granted = await requestRemoteDesktopConfirmation({
            confirmationSessionId,
            scope,
            toolName: 'remote_pane_input',
            reason: 'comando destrutivo, remoto, de deploy ou publicação',
            args: { command: inputDecision.command, paneId: msg.paneId },
          });
          if (!granted) {
            throw new Error(
              'not authorized: desktop confirmation required or denied',
            );
          }
        }
        sessionId ??= sessionIdOf(msg.paneId, scope, 'write');
        return orchWriteSession(sessionId, `${inputDecision.command}\n`);
      };
      // Reenvio do outbox (mesmo messageId): devolve a primeira entrega sem
      // escrever de novo no PTY.
      const { result: ok, deduplicated } =
        messageId && sessionId
          ? await paneInputDedup.run(
              `${scope.projectId}\0${sessionId}\0${messageId}`,
              deliverInput,
            )
          : { result: await deliverInput(), deduplicated: false };
      // Keep stream session alive for resume; optional echo frame for clients
      // that consume binary terminal-stream-protocol over JSON transport.
      const stream = encodeRemoteTerminalOutput(
        sessionId ?? sessionIdOf(msg.paneId, scope, 'write'),
        '',
      );
      return deduplicated ? { ok, stream, deduplicated } : { ok, stream };
    }
    case 'pane.stream.open': {
      const sessionId = sessionIdOf(msg.paneId, scope, 'read');
      const subscribed = Boolean(pushTarget);
      if (pushTarget) subscribePaneStream(pushTarget, sessionId);
      return {
        ...openRemoteTerminalStream(sessionId),
        // Negociação explícita: bridges antigas respondem sem esta flag e o
        // cliente mantém o poll de 2,5 s como fonte primária.
        pushAvailable: subscribed,
        pushSeq: peekPushCursor(sessionId),
      };
    }
    case 'pane.stream.close': {
      // Sem paneId: encerra TODAS as inscrições deste socket (troca de pane no
      // thin client). Frames de pane antigo parariam de consumir o buffer do
      // socket — é o cliente abrindo mão do próprio push, sem authz extra.
      if (!pushTarget) return { ok: true };
      if (typeof msg.paneId === 'string' && msg.paneId.length > 0) {
        unsubscribePaneStream(pushTarget, sessionIdOf(msg.paneId, scope, 'read'));
      } else {
        unsubscribePaneStream(pushTarget);
      }
      return { ok: true };
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
        // Binary terminal frames are a raw keystream. Classifying each frame
        // is bypassable by splitting `rm -rf` across frames, so remote writes
        // must use pane.input's complete-command authority boundary.
        throw new Error(
          'not authorized: raw terminal input is disabled; use pane.input',
        );
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
      return { ok: await requestPaneClose(pane.paneId) };
    }
    case 'mission.list':
      // Keep array shape for backward compatibility (older mobile clients).
      return getProjectDomainStores(scope).missions.list();
    case 'ops.snapshot': {
      // Phone home: compact mission DTOs + panes (full detail stays on desktop).
      // MOB-12: sem `read`, nada de missões nem panes; pedidos de aprovação
      // só com `read` ou `approve`.
      const missions = canRead
        ? getProjectDomainStores(scope).missions.list().map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            updatedAt: m.updatedAt,
          }))
        : [];
      const panes = canRead ? listVisiblePaneSnapshots(remoteCaller(scope)) : [];
      return {
        missions,
        panes,
        approvals:
          canRead || deviceScopes.includes('approve') ? remoteApprovalsFor(scope) : [],
        summary: {
          missions: missions.length,
          panes: panes.length,
          runningMissions: missions.filter((m) => m.status === 'running').length,
          busyPanes: panes.filter((p) => p.state === 'busy').length,
        },
        generatedAt: Date.now(),
      };
    }
    case 'status':
      return redactRemoteBridgeSecrets(getRemoteBridgeInfo(scope));
    // F-1014: Git e arquivos do checkout de um pane que o aparelho pode LER —
    // só leitura, pelos serviços do desktop (remote-workspace-rpc.ts). Stage,
    // commit, checkout e escrita não têm comando aqui: caem em `unknown command`.
    case 'git.status':
      return remoteGitStatus(resolveRemotePaneWorkspace(msg.paneId, scope));
    case 'git.diff':
      return remoteGitDiff(resolveRemotePaneWorkspace(msg.paneId, scope), msg.path, {
        staged: msg.staged === true,
        untracked: msg.untracked === true,
      });
    case 'files.list':
      return remoteFilesList(resolveRemotePaneWorkspace(msg.paneId, scope), msg.path);
    case 'files.read':
      return remoteFilesRead(resolveRemotePaneWorkspace(msg.paneId, scope), msg.path);
    default:
      throw new Error(`unknown command: ${msg.type}`);
  }
}

function onConnection(ws: WebSocket, req: IncomingMessage) {
  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, 'too many connections');
    return;
  }
  // Cross-site WebSocket-hijacking defense: a browser sends an Origin header, so
  // only same-origin browser pages (the served thin-client) are accepted. Native
  // apps send no Origin and are unaffected. Auth uses an explicit device-bound
  // token + proof in messages (never an ambient cookie), so this remains
  // defense-in-depth against pre-auth reach. Tailscale Serve preserves Host, so
  // the *.ts.net page passes the same check; X-Forwarded-Host and
  // Tailscale-User-* are never accepted as proof of origin.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const host = req.headers.host;
    const sameOrigin =
      !!host && (origin === `https://${host}` || origin === `http://${host}`);
    if (!sameOrigin) {
      ws.close(1008, 'origin not allowed');
      return;
    }
  }
  clients.add(ws);
  const ip = clientIp(req);
  // Loopback = desktop local ou qualquer aparelho do tailnet via Serve: o IP
  // não distingue ninguém e X-Forwarded-* nunca vira identidade. A
  // pré-autenticação conta por conexão; depois do auth, pela identidade
  // comprovada no Main (tokenId), em bucket próprio. O pareamento conta pela
  // partição do peer carimbada pelo Serve, quando há (servePeerPartition).
  const proxied = isLoopbackAddress(ip);
  const partition = servePeerPartition(req, proxied);
  const preAuthKey = proxied ? `pre:conn:${(connectionSeq += 1)}` : `pre:ip:${ip}`;
  // Lockout por partição sobrevive à reconexão; sem partição, por conexão.
  const pairingKey = partition ? `peer:${partition}` : proxied ? preAuthKey : ip;
  // Reap sockets that connect but never authenticate — they otherwise pin a
  // slot and file descriptors indefinitely.
  const unauthTimer = setTimeout(() => {
    if (!authenticatedClients.has(ws)) ws.close(1008, 'auth timeout');
  }, UNAUTH_TIMEOUT_MS);
  ws.on('close', () => {
    clearTimeout(unauthTimer);
    if (proxied) {
      rate.delete(preAuthKey);
      if (!partition) pairingFailuresByIp.delete(pairingKey);
    }
    clearAuthenticatedClient(ws);
    dropStreamSubscriber(ws);
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
      const authenticatedKey = authenticatedClients.get(ws)?.tokenId;
      if (!rateOk(authenticatedKey ? `device:${authenticatedKey}` : preAuthKey)) {
        throw new Error('rate limited');
      }
      const msg = command(parsed);
      if (proxied && msg.type === 'pair') {
        // Partição primeiro: um peer acima do próprio teto não gasta a rede.
        const partitionOk = partition
          ? rateOk(`pre:peer:${partition}`, PEER_PAIR_ATTEMPTS_PER_MINUTE)
          : rateOk(LOCAL_PAIR_RATE_KEY, LOCAL_PAIR_ATTEMPTS_PER_MINUTE);
        if (!partitionOk || !rateOk(PROXY_PAIR_RATE_KEY, PROXY_PAIR_ATTEMPTS_PER_MINUTE)) {
          throw new Error('rate limited');
        }
      }
      if (msg.type === 'ping') {
        send(ws, { id: msg.id, ok: true, result: { pong: true } });
        return;
      }
      if (msg.type === 'pair') {
        const scope = activeBridgeScope;
        if (!scope) throw new Error('bridge project scope is unavailable');
        const identity = parseRemoteDeviceIdentity({
          deviceId: msg.deviceId,
          publicKey: msg.devicePublicKey,
        });
        if (!identity) throw new Error('device identity required');
        if (pairingLockRemaining(pairingKey) > 0) {
          throw new Error('too many attempts; try again later');
        }
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        const current = pairingCode();
        const supplied = Buffer.from(code);
        const expected = Buffer.from(current.code);
        const match =
          supplied.length === expected.length &&
          crypto.timingSafeEqual(supplied, expected) &&
          Date.now() <= current.expiresAt;
        if (!match) {
          // Per-IP (per-connection behind the proxy) lockout — never rotate
          // the shared code an honest user is actively scanning (L16).
          recordPairingFailure(pairingKey);
          throw new Error('invalid pairing code');
        }
        if (
          !verifyRemoteDeviceSignature({
            publicKey: identity.publicKey,
            challenge: `nexus-remote-pair-v1:${current.code}`,
            signature: msg.deviceProof,
          })
        ) {
          throw new Error('invalid device proof');
        }
        pairingFailuresByIp.delete(pairingKey);
        const issued = issueRemoteDeviceToken(
          scope,
          identity.deviceId,
          identity.publicKey,
          current.scopes, // MOB-12
        );
        authenticateClient(ws, issued.record, scope);
        clearTimeout(unauthTimer);
        // The desktop-issued code is a one-device approval. Successful use
        // consumes it; adding another device requires an explicit rotate.
        invalidatePairing();
        send(ws, {
          id: msg.id,
          ok: true,
          result: {
            token: issued.token,
            expiresAt: issued.expiresAt,
            deviceKeyFingerprint: issued.record.deviceKeyFingerprint,
          },
        });
        return;
      }
      if (msg.type === 'auth.challenge') {
        const scope = activeBridgeScope;
        if (!scope) throw new Error('bridge project scope is unavailable');
        const token = typeof msg.token === 'string' ? msg.token : '';
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : '';
        const record = findRemoteDeviceToken(token, scope, deviceId);
        if (!record) throw new Error('invalid token or device');
        const challenge: AuthenticationChallenge = {
          id: crypto.randomUUID(),
          challenge: `nexus-remote-auth-v1:${crypto
            .randomBytes(32)
            .toString('base64url')}`,
          tokenId: record.id,
          deviceId,
          expiresAt: Date.now() + AUTH_CHALLENGE_TTL_MS,
        };
        authenticationChallenges.set(ws, challenge);
        send(ws, {
          id: msg.id,
          ok: true,
          result: {
            challengeId: challenge.id,
            challenge: challenge.challenge,
            expiresAt: challenge.expiresAt,
          },
        });
        return;
      }
      if (msg.type === 'auth') {
        const scope = activeBridgeScope;
        if (!scope) throw new Error('bridge project scope is unavailable');
        const token = typeof msg.token === 'string' ? msg.token : '';
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : '';
        const challengeId =
          typeof msg.challengeId === 'string' ? msg.challengeId : '';
        const challenge = authenticationChallenges.get(ws);
        // Single-use even on malformed proof: retries must request a fresh
        // challenge, preventing replay/oracle behavior.
        authenticationChallenges.delete(ws);
        const record = findRemoteDeviceToken(token, scope, deviceId);
        if (
          !record ||
          !challenge ||
          challenge.id !== challengeId ||
          challenge.tokenId !== record.id ||
          challenge.deviceId !== deviceId ||
          challenge.expiresAt < Date.now() ||
          !verifyRemoteDeviceSignature({
            publicKey: record.devicePublicKey,
            challenge: challenge.challenge,
            signature: msg.signature,
          })
        ) {
          throw new Error('invalid device authentication');
        }
        authenticateClient(ws, record, scope);
        clearTimeout(unauthTimer);
        send(ws, { id: msg.id, ok: true, result: { ok: true } });
        return;
      }
      if (!isClientAuthenticated(ws)) throw new Error('auth required');
      const authenticated = authenticatedClients.get(ws);
      if (!authenticated) throw new Error('auth required');
      const result = await handleAuthedMessage(
        msg,
        authenticated.scope,
        ws,
        `remote-device:${authenticated.tokenId}`,
        remoteDeviceTokenScopes(authenticated.tokenId), // MOB-12
      );
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
  req: RemoteBridgeStartRequest,
  scope: ProjectExecutionScope,
): Promise<RemoteBridgeInfo> {
  if (!scope) throw new Error('remote bridge requires a project scope');
  if (server && port) {
    assertBridgeScope(scope);
    if (req.tailscale !== undefined) await applyBridgeTailscale(req.tailscale);
    return getRemoteBridgeInfo(scope);
  }
  activeBridgeScope = Object.freeze({ ...scope });
  // Starting the bridge is the desktop user's explicit issuance/approval of
  // one pairing code. Expiry/consumption never auto-mints another code.
  pairing = makePairing(req.scopes); // MOB-12
  const tls = await ensureTls();
  // Default seguro: só localhost. Expor na LAN (0.0.0.0/::) exige pedido
  // explícito do usuário — a bridge controla PTYs reais.
  const host = req.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server = https.createServer(
      { key: tls.key, cert: tls.cert },
      serveRemoteClientPage,
    );
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
  // O Serve encaminha o tailnet ao loopback: funciona até com o bind padrão
  // 127.0.0.1, sem expor a bridge na LAN.
  if (req.tailscale) await applyBridgeTailscale(true);
  return getRemoteBridgeInfo(scope);
}

export function stopRemoteBridge(scope?: ProjectExecutionScope): RemoteBridgeInfo {
  clearStreamSubscriptions();
  clearRemoteTerminalStreams();
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  bridgeGeneration += 1;
  releaseBridgeTailscale();
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
  invalidatePairing();
  activeBridgeScope = null;
  return getRemoteBridgeInfo();
}

export function rotateRemotePairing(
  scope?: ProjectExecutionScope,
  scopes?: readonly RemoteDeviceScope[], // MOB-12: ausente = todos
): RemoteBridgeInfo {
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  pairing = makePairing(scopes);
  return getRemoteBridgeInfo(scope);
}

// MOB-12 (início): o operador edita os escopos de um aparelho pareado. Vale no
// próximo pedido dele (o dispatch lê o grant a cada mensagem), sem reconectar.
export function setRemoteDeviceScopes(
  scope: ProjectExecutionScope,
  deviceId: string,
  scopes: readonly RemoteDeviceScope[],
): RemoteBridgeInfo {
  if (activeBridgeScope) assertBridgeScope(scope);
  if (!setRemoteDeviceTokenScopes({ tokenId: deviceId, scope, scopes })) {
    throw new Error('device not found');
  }
  return getRemoteBridgeInfo(scope);
}
// MOB-12 (fim)

export function revokeRemoteTokens(scope?: ProjectExecutionScope): RemoteBridgeInfo {
  if (scope && activeBridgeScope) assertBridgeScope(scope);
  const target = scope ?? activeBridgeScope;
  revokeRemoteDeviceTokens(target ?? undefined);
  closeAllAuthenticatedClients('tokens revoked');
  return getRemoteBridgeInfo(scope);
}

export type RemoteBridgeRedactedInfo = Omit<
  RemoteBridgeInfo,
  'pairingCode' | 'pairingExpiresAt' | 'pairingScopes' | 'devices'
>;

export function redactRemoteBridgeSecrets(
  info: RemoteBridgeInfo,
): RemoteBridgeRedactedInfo {
  const {
    pairingCode: _pairingCode,
    pairingExpiresAt: _pairingExpiresAt,
    // MOB-12: um aparelho não enumera os outros nem o que o código concede.
    pairingScopes: _pairingScopes,
    devices: _devices,
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
  const pairingAvailable =
    current.code.length === PAIRING_LEN && current.expiresAt > Date.now();
  const tokenScope = scope ?? activeBridgeScope;
  const endpoints = port ? localEndpoints(port) : [];
  return {
    running: Boolean(server && port),
    port: port ?? undefined,
    urls: endpoints.map((endpoint) => endpoint.url),
    endpoints,
    pairingCode: pairingAvailable ? current.code : undefined,
    pairingExpiresAt: pairingAvailable ? current.expiresAt : undefined,
    // MOB-12 (início)
    pairingScopes: pairingAvailable ? [...current.scopes] : undefined,
    devices: listRemoteDeviceTokens(tokenScope ?? undefined).map((token) => ({
      id: token.id,
      keyFingerprint: token.deviceKeyFingerprint,
      pairedAt: token.createdAt,
      expiresAt: token.expiresAt,
      scopes: [...token.scopes],
      connected: [...authenticatedClients.values()].some((client) => client.tokenId === token.id),
    })),
    // MOB-12 (fim)
    tokenCount: countRemoteDeviceTokens(tokenScope ?? undefined),
    clientCount: clients.size,
    certFingerprint: tlsRecord?.fingerprint,
    ...(bridgeTailscale ? { tailscale: { ...bridgeTailscale.info } } : {}),
  };
}

/**
 * Status para a UI: sem Serve desta bridge, anexa a detecção da CLI (só
 * `status --json`, sem efeito) para o toggle nascer ligado quando dá.
 */
export async function getRemoteBridgeStatus(
  scope?: ProjectExecutionScope,
): Promise<RemoteBridgeInfo> {
  const info = getRemoteBridgeInfo(scope);
  if (info.tailscale) return info;
  return { ...info, tailscale: await detectRemoteBridgeTailscale() };
}

/**
 * Quit: espera o `serve off` em curso, com teto — nunca segura o encerramento.
 * O que não couber fica no marcador e o próximo boot remove.
 */
export async function settleRemoteBridgeTailscale(timeoutMs = 2_500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tailscaleQueue,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Boot: remove o handler do Serve que uma execução anterior deixou. Com a
 * consulta do Serve falhando (ex.: o Nexus subiu antes do Tailscale.app) a
 * limpeza se repete no mesmo cronograma do stop, sem desistir, enquanto
 * houver marcador de pid morto. Uma nova chamada reinicia o cronograma.
 */
export function cleanupRemoteBridgeTailscaleOrphan(): Promise<void> {
  if (orphanRetryTimer) {
    clearTimeout(orphanRetryTimer);
    tailscaleRetryTimers.delete(orphanRetryTimer);
    orphanRetryTimer = null;
  }
  return runOrphanCleanup(0);
}

/** Só para testes: cancela as novas tentativas pendentes de unpublish/limpeza. */
export function cancelRemoteBridgeTailscaleRetries(): void {
  for (const timer of tailscaleRetryTimers) clearTimeout(timer);
  tailscaleRetryTimers.clear();
  orphanRetryTimer = null;
}
