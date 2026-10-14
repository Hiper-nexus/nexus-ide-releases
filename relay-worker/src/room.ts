/**
 * Uma sala do relay = um Durable Object. Protocolo idêntico ao do relay da
 * Railway (`server/src/relay/server.ts`) e ao embutido (`blind-relay.ts`):
 *
 * - O host cria a sala; segundo host leva 4009, guest sem sala leva 4004 e
 *   guest além de RELAY_MAX_PEERS_PER_ROOM leva 4029; acima de
 *   RELAY_MAX_ROOMS salas abertas, o host leva 4029 ('relay at capacity').
 * - Frames binários `[4B uint32 BE peerId][payload selado]`: do host, peerId 0
 *   vai a todos os guests e N só ao guest N, sem alteração; do guest, os 4
 *   primeiros bytes viram o peerId dele e o frame vai ao host. Frame binário
 *   com menos de 4 bytes, ou qualquer frame (TEXT em bytes UTF-8) acima de
 *   RELAY_MAX_FRAME_BYTES, fecha quem mandou com 1009.
 * - TEXT de controle: ao host `{"t":"peer-joined","peer":N}` e
 *   `{"t":"peer-left","peer":N}`; ao guest `{"t":"room-closed"}` + close 4001.
 *   TEXT vindo de cliente não é encaminhado.
 * - Sala sem frame binário por RELAY_ROOM_TTL_MS fecha guests (4001 'room
 *   closed') e host (4001 'idle timeout').
 *
 * O relay é cego: recebe ciphertext e o roomId, não decifra e não guarda nem
 * registra payload, chave ou token.
 *
 * Conexão meio-aberta (rede caiu sem close) não fecha sozinha. Cada conexão
 * guarda quando mandou o último frame; o runtime guarda o último ping:
 *
 * - Heartbeat: Workers não manda ping de protocolo. O cliente manda o TEXT
 *   `{"t":"ping"}` e o runtime responde `{"t":"pong"}` sem acordar o DO.
 *   Quem já pingou e passa 2 × RELAY_HEARTBEAT_MS calado cai com 1001.
 * - Vaga ociosa: quem não pinga (desktop até 0.76.251, PWA) não é derrubado
 *   por silêncio, mas host calado há mais de RELAY_IDLE_TAKEOVER_MS cede a
 *   sala a um novo host, e guest calado há esse tempo cede a vaga a um novo
 *   guest com a sala cheia (4008 para quem sai). Host ativo segue com 4009.
 * - Mais de RELAY_MAX_MESSAGES_PER_SECOND mensagens numa janela de 1 s: 1008.
 *
 * Estado de sala mora no anexo do WebSocket do host (sobrevive à hibernação e
 * morre com ele, como a sala da Railway); o storage só guarda o alarme.
 */
import { relayConfig, type RelayConfig } from './config';
import type { RegistryOp } from './registry';
import { nextCheckAt } from './schedule';

const PEER_HEADER_BYTES = 4;
const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
const ROOM_CLOSED = '{"t":"room-closed"}';
const UTF8 = new TextEncoder();

const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_NO_ROOM = 4004;
const CLOSE_REPLACED = 4008;
const CLOSE_HOST_CONFLICT = 4009;
const CLOSE_FULL = 4029;
const CLOSE_INVALID_FRAME = 1009;
const CLOSE_RATE_LIMIT = 1008;
/** Não fatal no desktop: se o "zumbi" estava vivo, ele reconecta. */
const CLOSE_HEARTBEAT = 1001;
const CLOSE_BUSY = 1011;

interface HostAttachment {
  role: 'host';
  /** Identifica esta sala; guests de um host anterior nunca casam com ela. */
  epoch: string;
  nextPeerId: number;
  joinedMs: number;
  /** Último frame recebido deste host. */
  seenMs: number;
  /** Último frame binário de qualquer um: base do TTL da sala. */
  lastActivityMs: number;
  /** Última renovação do aluguel no RelayRegistry. */
  leaseRenewedMs: number;
  retired?: true;
}

interface GuestAttachment {
  role: 'guest';
  epoch: string;
  peerId: number;
  joinedMs: number;
  seenMs: number;
  /** O relay já o tirou da sala (e avisou o host). */
  gone?: true;
}

type Attachment = HostAttachment | GuestAttachment;

interface Peer<A extends Attachment> {
  ws: WebSocket;
  att: A;
}

type AnyPeer = Peer<HostAttachment> | Peer<GuestAttachment>;

function attachmentOf(ws: WebSocket): Attachment | null {
  try {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, message: ArrayBuffer | string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(message);
  } catch {
    // Fechando: o close dele decide o resto.
  }
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.close();
    } catch {
      // Já fechado.
    }
  }
}

function rateKey(att: Attachment): string {
  return att.role === 'host' ? `${att.epoch}:host` : `${att.epoch}:${att.peerId}`;
}

export class RelayRoom implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #config: RelayConfig;
  /** Janela de 1 s por conexão; some na hibernação, que só acontece sem tráfego. */
  readonly #rates = new Map<string, { windowStart: number; count: number }>();

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#config = relayConfig(env);
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'host' && role !== 'guest') return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    const now = Date.now();
    if (role === 'host') await this.#acceptHost(pair[1], now);
    else await this.#acceptGuest(pair[1], now);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async #acceptHost(socket: WebSocket, now: number): Promise<void> {
    const current = this.#host();
    if (current && now - this.#lastSeen(current) <= this.#config.idleTakeoverMs) {
      return this.#refuse(socket, CLOSE_HOST_CONFLICT, 'host already connected');
    }
    // Host calado além do limite: meio-aberto (a rede caiu sem close) ou desktop
    // antigo sem ping. O novo host assume em vez de levar 4009 do zumbi.
    if (current) this.#retire(current, CLOSE_REPLACED, 'replaced by a new host');
    this.#state.acceptWebSocket(socket, ['host']);
    const host: Peer<HostAttachment> = {
      ws: socket,
      att: {
        role: 'host',
        epoch: crypto.randomUUID(),
        nextPeerId: 1,
        joinedMs: now,
        seenMs: now,
        lastActivityMs: now,
        leaseRenewedMs: now,
      },
    };
    socket.serializeAttachment(host.att);
    let admitted: boolean;
    try {
      // A sala assumida já é contada: só renova.
      admitted = await this.#registry(current ? 'renew' : 'acquire');
    } catch {
      return this.#retire(host, CLOSE_BUSY, 'relay busy');
    }
    if (!admitted) return this.#retire(host, CLOSE_FULL, 'relay at capacity');
    await this.#schedule(host, now);
  }

  async #acceptGuest(socket: WebSocket, now: number): Promise<void> {
    const host = this.#host();
    if (!host) return this.#refuse(socket, CLOSE_NO_ROOM, 'no such room');
    const guests = this.#guests(host.att.epoch);
    if (guests.length >= this.#config.maxPeersPerRoom) {
      const idlest = guests.reduce((a, b) => (this.#lastSeen(a) <= this.#lastSeen(b) ? a : b));
      if (now - this.#lastSeen(idlest) <= this.#config.idleTakeoverMs) {
        return this.#refuse(socket, CLOSE_FULL, 'room is full');
      }
      this.#dropGuest(host, idlest, CLOSE_REPLACED, 'replaced by a new connection');
    }
    const peerId = host.att.nextPeerId;
    host.att.nextPeerId = peerId + 1;
    host.att.lastActivityMs = now;
    host.ws.serializeAttachment(host.att);
    this.#state.acceptWebSocket(socket, ['guest']);
    const att: GuestAttachment = { role: 'guest', epoch: host.att.epoch, peerId, joinedMs: now, seenMs: now };
    socket.serializeAttachment(att);
    send(host.ws, JSON.stringify({ t: 'peer-joined', peer: peerId }));
    await this.#schedule(host, now);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = attachmentOf(ws);
    const host = this.#host();
    if (!att || !host || att.epoch !== host.att.epoch) return;
    if (att.role === 'guest' && att.gone) return;
    const peer: AnyPeer = att.role === 'host' ? host : { ws, att };
    const now = Date.now();
    if (!this.#allow(peer.att, now)) return this.#expel(host, peer, CLOSE_RATE_LIMIT, 'rate limit');
    const isText = typeof message === 'string';
    const bytes = isText ? UTF8.encode(message).byteLength : message.byteLength;
    if (bytes > this.#config.maxFrameBytes || (!isText && bytes < PEER_HEADER_BYTES)) {
      return this.#expel(host, peer, CLOSE_INVALID_FRAME, 'invalid frame');
    }
    peer.att.seenMs = now;
    if (isText) {
      // Prova de vida, mais nada: não encaminha nem renova o TTL (como a Railway).
      peer.ws.serializeAttachment(peer.att);
      return;
    }
    host.att.lastActivityMs = now;
    if (peer !== host) peer.ws.serializeAttachment(peer.att);
    host.ws.serializeAttachment(host.att);
    if (peer.att.role === 'host') {
      const target = new DataView(message).getUint32(0, false);
      for (const guest of this.#guests(host.att.epoch)) {
        if (target === 0 || guest.att.peerId === target) send(guest.ws, message);
      }
      return;
    }
    new DataView(message).setUint32(0, peer.att.peerId, false);
    send(host.ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    close(ws, code, reason);
    await this.#left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    close(ws, CLOSE_BUSY, 'error');
    await this.#left(ws);
  }

  async alarm(): Promise<void> {
    const host = this.#host();
    // Sala sem host (fechou, ou um reinício levou os sockets sem close): libera a vaga.
    if (!host) return this.#release();
    const now = Date.now();
    if (now - host.att.lastActivityMs > this.#config.roomTtlMs) {
      // Sem isto o host seguia "conectado" a uma sala morta e todo QR dava
      // 4004. 4001 é fatal no desktop: ele apaga o QR e oferece um novo.
      return this.#endRoom(host, CLOSE_ROOM_CLOSED, 'idle timeout');
    }
    if (this.#stale(host, now)) return this.#endRoom(host, CLOSE_HEARTBEAT, 'heartbeat timeout');
    for (const guest of this.#guests(host.att.epoch)) {
      if (this.#stale(guest, now)) this.#dropGuest(host, guest, CLOSE_HEARTBEAT, 'heartbeat timeout');
    }
    if (now - host.att.leaseRenewedMs >= this.#config.roomTtlMs / 2) {
      host.att.leaseRenewedMs = now;
      host.ws.serializeAttachment(host.att);
      await this.#registry('renew').catch(() => false);
    }
    await this.#schedule(host, now);
  }

  /** O host atual: aberto e não aposentado. Há no máximo um. */
  #host(): Peer<HostAttachment> | null {
    for (const ws of this.#state.getWebSockets('host')) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = attachmentOf(ws);
      if (att?.role === 'host' && !att.retired) return { ws, att };
    }
    return null;
  }

  #guests(epoch: string): Peer<GuestAttachment>[] {
    const guests: Peer<GuestAttachment>[] = [];
    for (const ws of this.#state.getWebSockets('guest')) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = attachmentOf(ws);
      if (att?.role === 'guest' && att.epoch === epoch && !att.gone) guests.push({ ws, att });
    }
    return guests;
  }

  #lastPing(ws: WebSocket): number | null {
    return this.#state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
  }

  /** Última prova de vida: frame recebido ou ping respondido pelo runtime. */
  #lastSeen(peer: AnyPeer): number {
    return Math.max(peer.att.seenMs, this.#lastPing(peer.ws) ?? 0);
  }

  /** Já pingou e está calado há mais de 2 intervalos: socket meio-aberto. */
  #stale(peer: AnyPeer, now: number): boolean {
    return this.#lastPing(peer.ws) !== null && now - this.#lastSeen(peer) > 2 * this.#config.heartbeatMs;
  }

  #allow(att: Attachment, now: number): boolean {
    const key = rateKey(att);
    const window = this.#rates.get(key);
    if (!window || now - window.windowStart >= 1_000) {
      this.#rates.set(key, { windowStart: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.#config.maxMessagesPerSecond;
  }

  async #schedule(host: Peer<HostAttachment>, now: number): Promise<void> {
    const peers = [host, ...this.#guests(host.att.epoch)].map((peer) => ({
      joinedMs: peer.att.joinedMs,
      seenMs: peer.att.seenMs,
      lastPingMs: this.#lastPing(peer.ws),
    }));
    await this.#state.storage.setAlarm(
      nextCheckAt({
        now,
        lastActivityMs: host.att.lastActivityMs,
        roomTtlMs: this.#config.roomTtlMs,
        heartbeatMs: this.#config.heartbeatMs,
        peers,
      }),
    );
  }

  /** Fecha a sala: guests recebem room-closed + 4001; o host fecha com `code`. */
  #retire(host: Peer<HostAttachment>, code: number, reason: string): void {
    host.att.retired = true;
    host.ws.serializeAttachment(host.att);
    this.#closeGuests(host.att.epoch);
    close(host.ws, code, reason);
  }

  /** Fecha a sala de vez e devolve a vaga no teto de salas. */
  async #endRoom(host: Peer<HostAttachment>, code: number, reason: string): Promise<void> {
    this.#retire(host, code, reason);
    await this.#release();
  }

  #expel(host: Peer<HostAttachment>, peer: AnyPeer, code: number, reason: string): Promise<void> | void {
    if (peer.att.role === 'host') return this.#endRoom(host, code, reason);
    this.#dropGuest(host, peer as Peer<GuestAttachment>, code, reason);
  }

  #closeGuests(epoch: string): void {
    for (const guest of this.#guests(epoch)) {
      send(guest.ws, ROOM_CLOSED);
      close(guest.ws, CLOSE_ROOM_CLOSED, 'room closed');
    }
  }

  #dropGuest(host: Peer<HostAttachment>, guest: Peer<GuestAttachment>, code: number, reason: string): void {
    guest.att.gone = true;
    guest.ws.serializeAttachment(guest.att);
    this.#rates.delete(rateKey(guest.att));
    close(guest.ws, code, reason);
    send(host.ws, JSON.stringify({ t: 'peer-left', peer: guest.att.peerId }));
  }

  async #left(ws: WebSocket): Promise<void> {
    const att = attachmentOf(ws);
    if (!att) return;
    this.#rates.delete(rateKey(att));
    if (att.role === 'host') {
      // Host saiu: a sala acaba com ele (a aposentada já fechou os guests).
      if (att.retired) return;
      this.#closeGuests(att.epoch);
      return this.#release();
    }
    if (att.gone) return;
    const host = this.#host();
    if (host && host.att.epoch === att.epoch) {
      send(host.ws, JSON.stringify({ t: 'peer-left', peer: att.peerId }));
    }
  }

  #refuse(socket: WebSocket, code: number, reason: string): void {
    // Fora da hibernação de propósito: não entra em getWebSockets() nem gera eventos.
    socket.accept();
    socket.close(code, reason);
  }

  async #registry(op: RegistryOp): Promise<boolean> {
    const registry = this.#env.RELAY_REGISTRY;
    const response = await registry.get(registry.idFromName('global')).fetch('https://registry.invalid/', {
      method: 'POST',
      body: JSON.stringify({ op, id: this.#state.id.toString(), leaseMs: 2 * this.#config.roomTtlMs }),
    });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    return ((await response.json()) as { ok?: unknown }).ok === true;
  }

  async #release(): Promise<void> {
    await this.#registry('release').catch(() => false);
  }
}
