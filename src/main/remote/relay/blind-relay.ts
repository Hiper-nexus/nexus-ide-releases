// Porte de can1357/oh-my-pi@03c48d073 packages/collab-web/scripts/local-relay.ts
// (MIT) de Bun.serve para o pacote `ws` (já dependência do Nexus), com
// endurecimentos que a referência não tem (caps, rate-limit, TTL, Origin).
/**
 * Relay CEGO do transporte E2E do companion mobile.
 *
 * Contrato idêntico ao do oh-my-pi:
 * - `GET /r/<roomId>?role=host|guest` faz upgrade para WebSocket.
 * - O host cria a sala; segundo host é rejeitado com close 4009 e guest em
 *   sala inexistente com close 4004.
 * - Frames binários do host: envelope peerId 0 → broadcast a todos os guests,
 *   peerId N → unicast àquele guest; encaminhados sem alteração.
 * - Frames binários de guest: os 4 primeiros bytes do envelope são
 *   reescritos com o peerId do remetente e o frame vai ao host.
 * - TEXT de controle ao host: `{"t":"peer-joined","peer":N}` /
 *   `{"t":"peer-left","peer":N}`; ao guest: `{"t":"room-closed"}` + close 4001.
 * - Sala cheia / relay cheio: close 4029 (fatal para o cliente — sem retry).
 *
 * Endurecimentos Nexus: máximo de salas, máximo de peers por sala, rate-limit
 * de upgrade por IP, tamanho máximo de frame, TTL de sala ociosa e verificação
 * de Origin quando servido para browser.
 *
 * O relay é CONTENT-BLIND: payloads ficam selados fim a fim e NUNCA são
 * logados — este módulo não loga nada; expõe apenas contadores via stats().
 */
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { unpackEnvelope, rewriteEnvelopePeer } from '../../../vendor/omp/wire/codec';
import { ENVELOPE_HEADER_LENGTH } from '../../../vendor/omp/wire';

export const RELAY_CLOSE_ROOM_CLOSED = 4001;
export const RELAY_CLOSE_NO_ROOM = 4004;
export const RELAY_CLOSE_HOST_CONFLICT = 4009;
export const RELAY_CLOSE_ROOM_FULL = 4029;

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

const DEFAULT_MAX_ROOMS = 32;
const DEFAULT_MAX_PEERS_PER_ROOM = 8;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_ROOM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
// Mesmo padrão de bucket por IP do remote-bridge: janela de 60s.
const DEFAULT_MAX_UPGRADES_PER_MINUTE = 30;
const RATE_MAP_SOFT_CAP = 4096;

interface SocketMeta {
  roomId: string;
  role: 'host' | 'guest';
  /** Atribuído no open para guests; o host fica em 0. */
  peerId: number;
}

interface Room {
  host: WebSocket;
  guests: Map<number, WebSocket>;
  nextPeerId: number;
  lastActivityMs: number;
}

export interface BlindRelayOptions {
  /** Porta de escuta (default 0 = efêmera). */
  port?: number;
  /** Endereço de bind (default 127.0.0.1 — expor exige pedido explícito). */
  host?: string;
  /** Material TLS opcional; sem ele o servidor é ws:// (localhost/testes). */
  tls?: { key: string; cert: string };
  maxRooms?: number;
  maxPeersPerRoom?: number;
  maxFrameBytes?: number;
  roomTtlMs?: number;
  sweepIntervalMs?: number;
  /**
   * Origins de browser permitidas. Requests de upgrade COM header Origin fora
   * desta lista são rejeitados antes do handshake (403). Clientes não-browser
   * (Node/mobile nativo) não enviam Origin e não são afetados.
   */
  allowedOrigins?: readonly string[];
  maxUpgradesPerIpPerMinute?: number;
}

export interface BlindRelay {
  /** ws(s)://host:port — anexar `/r/<roomId>?role=…` para conectar. */
  url: string;
  port: number;
  stats(): { rooms: number; peers: number };
  /** Fecha todas as salas e para o servidor. Idempotente. */
  stop(): Promise<void>;
}

/** Rate-limit por IP (mesmo padrão do remote-bridge, janela de 60s). */
class IpRateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  readonly #maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.#maxPerMinute = maxPerMinute;
  }

  allow(ip: string): boolean {
    const now = Date.now();
    if (this.#buckets.size > RATE_MAP_SOFT_CAP) {
      for (const [key, bucket] of this.#buckets) {
        if (bucket.resetAt < now) this.#buckets.delete(key);
      }
    }
    const bucket = this.#buckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      this.#buckets.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.#maxPerMinute;
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Socket já foi embora.
  }
  socket.destroy();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function startBlindRelay(
  options: BlindRelayOptions = {},
): Promise<BlindRelay> {
  const host = options.host ?? '127.0.0.1';
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const maxPeersPerRoom = options.maxPeersPerRoom ?? DEFAULT_MAX_PEERS_PER_ROOM;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const limiter = new IpRateLimiter(
    options.maxUpgradesPerIpPerMinute ?? DEFAULT_MAX_UPGRADES_PER_MINUTE,
  );

  const rooms = new Map<string, Room>();
  const meta = new WeakMap<WebSocket, SocketMeta>();

  const server = options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert })
    : http.createServer();
  server.on('request', (_req, res) => {
    // Nenhum estado é exposto por HTTP; o relay só fala WebSocket.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

  function touch(room: Room): void {
    room.lastActivityMs = Date.now();
  }

  function closeRoom(roomId: string, room: Room, hostCode: number, reason: string): void {
    rooms.delete(roomId);
    const closure = JSON.stringify({ t: 'room-closed' });
    for (const guest of room.guests.values()) {
      if (guest.readyState === guest.OPEN) guest.send(closure);
      guest.close(RELAY_CLOSE_ROOM_CLOSED, 'room closed');
    }
    room.guests.clear();
    room.host.close(hostCode, reason);
  }

  function onOpen(ws: WebSocket, roomId: string, role: 'host' | 'guest'): void {
    meta.set(ws, { roomId, role, peerId: 0 });
    attachHandlers(ws);
    if (role === 'host') {
      if (rooms.has(roomId)) {
        ws.close(RELAY_CLOSE_HOST_CONFLICT, 'a host is already connected for this room');
        return;
      }
      if (rooms.size >= maxRooms) {
        ws.close(RELAY_CLOSE_ROOM_FULL, 'relay at capacity');
        return;
      }
      rooms.set(roomId, {
        host: ws,
        guests: new Map(),
        nextPeerId: 1,
        lastActivityMs: Date.now(),
      });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      ws.close(RELAY_CLOSE_NO_ROOM, 'no such room');
      return;
    }
    if (room.guests.size >= maxPeersPerRoom) {
      ws.close(RELAY_CLOSE_ROOM_FULL, 'room is full');
      return;
    }
    const peerId = room.nextPeerId++;
    const socketMeta = meta.get(ws);
    if (socketMeta) socketMeta.peerId = peerId;
    room.guests.set(peerId, ws);
    touch(room);
    if (room.host.readyState === room.host.OPEN) {
      room.host.send(JSON.stringify({ t: 'peer-joined', peer: peerId }));
    }
  }

  function attachHandlers(ws: WebSocket): void {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // O único TEXT de cliente é o ping do heartbeat (F-1487): o pong diz que a
      // sala foi aceita. Controle TEXT é só relay→cliente.
      if (!isBinary) {
        if (toBuffer(data).toString() === '{"t":"ping"}' && ws.readyState === ws.OPEN) {
          ws.send('{"t":"pong"}');
        }
        return;
      }
      const socketMeta = meta.get(ws);
      if (!socketMeta) return;
      const room = rooms.get(socketMeta.roomId);
      if (!room) return;
      const bytes = toBuffer(data);
      if (bytes.byteLength > maxFrameBytes) {
        ws.close(1009, 'frame too large');
        return;
      }
      touch(room);
      if (socketMeta.role === 'host') {
        if (room.host !== ws) return;
        const envelope = unpackEnvelope(bytes);
        if (!envelope) return;
        if (envelope.peerId === 0) {
          for (const guest of room.guests.values()) {
            if (guest.readyState === guest.OPEN) guest.send(bytes);
          }
        } else {
          const guest = room.guests.get(envelope.peerId);
          if (guest && guest.readyState === guest.OPEN) guest.send(bytes);
        }
        return;
      }
      if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
      if (room.guests.get(socketMeta.peerId) !== ws) return;
      rewriteEnvelopePeer(bytes, socketMeta.peerId);
      if (room.host.readyState === room.host.OPEN) room.host.send(bytes);
    });
    ws.on('close', () => {
      const socketMeta = meta.get(ws);
      if (!socketMeta) return;
      const room = rooms.get(socketMeta.roomId);
      if (!room) return;
      if (socketMeta.role === 'host') {
        // Segundo host rejeitado: a sala viva não é dele para derrubar.
        if (room.host !== ws) return;
        rooms.delete(socketMeta.roomId);
        const closure = JSON.stringify({ t: 'room-closed' });
        for (const guest of room.guests.values()) {
          if (guest.readyState === guest.OPEN) guest.send(closure);
          guest.close(RELAY_CLOSE_ROOM_CLOSED, 'room closed');
        }
        room.guests.clear();
        return;
      }
      if (room.guests.get(socketMeta.peerId) === ws) {
        room.guests.delete(socketMeta.peerId);
        touch(room);
        if (room.host.readyState === room.host.OPEN) {
          room.host.send(JSON.stringify({ t: 'peer-left', peer: socketMeta.peerId }));
        }
      }
    });
    ws.on('error', () => {
      // Erro de protocolo (ex.: frame acima de maxPayload): derruba só o peer.
      try {
        ws.close(1009, 'protocol error');
      } catch {
        // Socket já foi embora.
      }
    });
  }

  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.allow(ip)) {
      rejectUpgrade(socket, '429 Too Many Requests');
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !allowedOrigins.has(origin)) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay.invalid');
    } catch {
      rejectUpgrade(socket, '400 Bad Request');
      return;
    }
    const match = ROOM_PATH_RE.exec(url.pathname);
    const role = url.searchParams.get('role');
    if (!match || (role !== 'host' && role !== 'guest')) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    const roomId = match[1]!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      onOpen(ws, roomId, role);
    });
  });

  // TTL de sala ociosa: sem tráfego por roomTtlMs, a sala é fechada (host
  // recebe close 4001 — fatal, sem retry automático que recriaria a sala).
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (now - room.lastActivityMs > roomTtlMs) {
        closeRoom(roomId, room, RELAY_CLOSE_ROOM_CLOSED, 'idle timeout');
      }
    }
  }, sweepIntervalMs);
  sweepTimer.unref?.();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('relay failed to bind'));
      }
    });
  });

  const scheme = options.tls ? 'wss' : 'ws';
  let stopped = false;

  return {
    url: `${scheme}://${host}:${port}`,
    port,
    stats(): { rooms: number; peers: number } {
      let peers = 0;
      for (const room of rooms.values()) peers += room.guests.size;
      return { rooms: rooms.size, peers };
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(sweepTimer);
      for (const [roomId, room] of [...rooms]) {
        closeRoom(roomId, room, 1001, 'relay shutting down');
      }
      rooms.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sockets já fechados acima; força o unref para não pendurar o loop.
        server.closeAllConnections?.();
      });
    },
  };
}
