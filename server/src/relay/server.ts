import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const PEER_HEADER_BYTES = 4;

type Role = 'host' | 'guest';

interface RelayOptions {
  port: number;
  host: string;
  allowedOrigins: ReadonlySet<string>;
  maxRooms: number;
  maxPeersPerRoom: number;
  maxFrameBytes: number;
  roomTtlMs: number;
  maxUpgradesPerIpPerMinute: number;
}

interface Room {
  host: WebSocket;
  guests: Map<number, WebSocket>;
  nextPeerId: number;
  lastActivityMs: number;
}

interface SocketMeta {
  roomId: string;
  role: Role;
  peerId: number;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function allowedOrigins(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.RELAY_ALLOWED_ORIGINS?.trim() ?? '';
  if (!raw && env.NODE_ENV === 'production') {
    throw new Error('RELAY_ALLOWED_ORIGINS is required in production');
  }
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const parsed = new URL(entry);
        if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== entry) {
          throw new Error(`RELAY_ALLOWED_ORIGINS must contain origins only: ${entry}`);
        }
        return parsed.origin;
      }),
  );
}

export function relayOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RelayOptions {
  const portName = env.RELAY_PORT ? 'RELAY_PORT' : 'PORT';
  return {
    port: positiveInteger(env, portName, 8787, 65_535),
    host: env.RELAY_HOST?.trim() || '0.0.0.0',
    allowedOrigins: allowedOrigins(env),
    maxRooms: positiveInteger(env, 'RELAY_MAX_ROOMS', 128, 10_000),
    maxPeersPerRoom: positiveInteger(env, 'RELAY_MAX_PEERS_PER_ROOM', 8, 128),
    maxFrameBytes: positiveInteger(env, 'RELAY_MAX_FRAME_BYTES', 256 * 1024, 4 * 1024 * 1024),
    roomTtlMs: positiveInteger(env, 'RELAY_ROOM_TTL_MS', 30 * 60 * 1000, 24 * 60 * 60 * 1000),
    maxUpgradesPerIpPerMinute: positiveInteger(
      env,
      'RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE',
      60,
      10_000,
    ),
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export async function startRelayServer(options = relayOptionsFromEnv()): Promise<void> {
  const rooms = new Map<string, Room>();
  const metadata = new WeakMap<WebSocket, SocketMeta>();
  const upgrades = new Map<string, { count: number; resetAt: number }>();
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: options.maxFrameBytes });

  const closeRoom = (roomId: string, room: Room): void => {
    rooms.delete(roomId);
    for (const guest of room.guests.values()) {
      if (guest.readyState === WebSocket.OPEN) guest.send('{"t":"room-closed"}');
      guest.close(4001, 'room closed');
    }
    room.guests.clear();
  };

  const attachSocket = (socket: WebSocket): void => {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const meta = metadata.get(socket);
      const room = meta ? rooms.get(meta.roomId) : undefined;
      if (!meta || !room) return;
      const frame = toBuffer(data);
      if (frame.byteLength > options.maxFrameBytes || frame.byteLength < PEER_HEADER_BYTES) {
        socket.close(1009, 'invalid frame');
        return;
      }
      room.lastActivityMs = Date.now();
      if (meta.role === 'host') {
        if (room.host !== socket) return;
        const targetPeer = frame.readUInt32BE(0);
        if (targetPeer === 0) {
          for (const guest of room.guests.values()) {
            if (guest.readyState === WebSocket.OPEN) guest.send(frame);
          }
          return;
        }
        const guest = room.guests.get(targetPeer);
        if (guest?.readyState === WebSocket.OPEN) guest.send(frame);
        return;
      }
      if (room.guests.get(meta.peerId) !== socket) return;
      frame.writeUInt32BE(meta.peerId, 0);
      if (room.host.readyState === WebSocket.OPEN) room.host.send(frame);
    });
    socket.on('close', () => {
      const meta = metadata.get(socket);
      const room = meta ? rooms.get(meta.roomId) : undefined;
      if (!meta || !room) return;
      if (meta.role === 'host') {
        if (room.host === socket) closeRoom(meta.roomId, room);
        return;
      }
      if (room.guests.delete(meta.peerId) && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({ t: 'peer-left', peer: meta.peerId }));
      }
    });
  };

  server.on('upgrade', (request, socket: Duplex, head) => {
    const now = Date.now();
    const ip = request.socket.remoteAddress ?? 'unknown';
    const quota = upgrades.get(ip);
    if (!quota || quota.resetAt < now) upgrades.set(ip, { count: 1, resetAt: now + 60_000 });
    else if (++quota.count > options.maxUpgradesPerIpPerMinute) return rejectUpgrade(socket, '429 Too Many Requests');

    const origin = request.headers.origin;
    if (typeof origin === 'string' && !options.allowedOrigins.has(origin)) {
      return rejectUpgrade(socket, '403 Forbidden');
    }
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    const match = ROOM_PATH.exec(url.pathname);
    const role = url.searchParams.get('role');
    if (!match || (role !== 'host' && role !== 'guest')) return rejectUpgrade(socket, '404 Not Found');

    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const roomId = match[1]!;
      if (role === 'host') {
        if (rooms.has(roomId)) return websocket.close(4009, 'host already connected');
        if (rooms.size >= options.maxRooms) return websocket.close(4029, 'relay at capacity');
        rooms.set(roomId, { host: websocket, guests: new Map(), nextPeerId: 1, lastActivityMs: now });
        metadata.set(websocket, { roomId, role, peerId: 0 });
      } else {
        const room = rooms.get(roomId);
        if (!room) return websocket.close(4004, 'no such room');
        if (room.guests.size >= options.maxPeersPerRoom) return websocket.close(4029, 'room is full');
        const peerId = room.nextPeerId++;
        room.guests.set(peerId, websocket);
        room.lastActivityMs = now;
        metadata.set(websocket, { roomId, role, peerId });
        if (room.host.readyState === WebSocket.OPEN) room.host.send(JSON.stringify({ t: 'peer-joined', peer: peerId }));
      }
      attachSocket(websocket);
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (now - room.lastActivityMs > options.roomTtlMs) closeRoom(roomId, room);
    }
  }, Math.min(options.roomTtlMs, 60_000));
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  process.stdout.write(`[relay] listening on ${options.port}\n`);

  const stop = (): void => {
    clearInterval(sweeper);
    for (const [roomId, room] of rooms) closeRoom(roomId, room);
    sockets.close();
    server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startRelayServer().catch((error: unknown) => {
    process.stderr.write(`[relay] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
