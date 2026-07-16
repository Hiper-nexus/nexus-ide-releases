/**
 * Transporte v2 do companion mobile: host Nexus ↔ relay cego ↔ guests, com
 * E2E AES-256-GCM (codec pi-wire vendorado). O relay nunca vê plaintext.
 *
 * Camada POR BAIXO da mobile-companion-policy: RPCs de guests com escrita são
 * roteados para o MESMO dispatch autenticado da bridge (injetado — em produção
 * `handleAuthedMessage` do remote-bridge), que aplica a política. Guests
 * view-only (sem writeToken) têm RPC mutante rejeitado AQUI, antes da
 * política (defense in depth); streams/estado continuam chegando a eles.
 *
 * NUNCA logar chaves, tokens, links ou payloads.
 */
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  COMPANION_RELAY_PROTO,
  COMPANION_VIEW_ONLY_RPC_TYPES,
  type CompanionGuestFrame,
  type CompanionHostFrame,
  type CompanionRelayTransportInfo,
  type CompanionRpcRequest,
} from '../../../shared/companion-relay-types';
import { importRoomKey } from '../../../vendor/omp/wire/codec';
import type { RelayControlMessage } from '../../../vendor/omp/wire';
import { encodeQrSvg } from '../../../vendor/qrcode';
import { encodeRemoteTerminalOutput } from '../remote-terminal-streams';
import {
  createRelayRoomSecrets,
  formatRelayRoomLink,
  normalizeRelayOrigin,
  verifyGuestWriteToken,
  type RelayRoomSecrets,
} from './room-link';
import { RelaySocket } from './relay-socket';

/** Mensagem autenticada no shape que o dispatch da bridge espera. */
export interface CompanionDispatchMessage {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export type CompanionRelayDispatch = (
  msg: CompanionDispatchMessage,
  scope: ProjectExecutionScope,
) => Promise<unknown>;

export interface CompanionRelayHostOptions {
  /** URL do relay (wss://…; ws:// só localhost). Validada em start(). */
  relayUrl: string;
  scope: ProjectExecutionScope;
  /** Dispatch autenticado da bridge (a policy decide lá dentro). */
  dispatch: CompanionRelayDispatch;
  sessionName?: string;
}

interface PeerState {
  name: string;
  helloed: boolean;
  canWrite: boolean;
}

const VIEW_ONLY_TYPES = new Set(COMPANION_VIEW_ONLY_RPC_TYPES);
const MAX_GUEST_NAME_CHARS = 64;

export class CompanionRelayHost {
  readonly #options: CompanionRelayHostOptions;
  readonly #peers = new Map<number, PeerState>();
  #secrets: RelayRoomSecrets | null = null;
  #socket: RelaySocket | null = null;
  #fullLink: string | null = null;
  #viewLink: string | null = null;
  #qrSvgFull: string | null = null;
  #qrSvgView: string | null = null;
  #connected = false;
  #running = false;
  #lastError: string | null = null;

  constructor(options: CompanionRelayHostOptions) {
    this.#options = options;
  }

  get scope(): ProjectExecutionScope {
    return this.#options.scope;
  }

  async start(): Promise<CompanionRelayTransportInfo> {
    if (this.#running) return this.info();
    const normalized = normalizeRelayOrigin(this.#options.relayUrl);
    if ('error' in normalized) throw new Error(normalized.error);
    const secrets = createRelayRoomSecrets();
    this.#secrets = secrets;
    this.#fullLink = formatRelayRoomLink(
      normalized.origin,
      secrets.roomId,
      secrets.roomKey,
      secrets.writeToken,
    );
    this.#viewLink = formatRelayRoomLink(
      normalized.origin,
      secrets.roomId,
      secrets.roomKey,
    );
    this.#qrSvgFull = encodeQrSvg(this.#fullLink);
    this.#qrSvgView = encodeQrSvg(this.#viewLink);
    const key = await importRoomKey(secrets.roomKey);
    const socket = new RelaySocket({
      wsUrl: `${normalized.origin}/r/${secrets.roomId}`,
      role: 'host',
      key,
    });
    socket.onOpen = () => {
      this.#connected = true;
    };
    socket.onControl = (msg: RelayControlMessage) => {
      this.#handleControl(msg);
    };
    socket.onFrame = (frame: unknown, fromPeer: number) => {
      this.#handleFrame(frame, fromPeer);
    };
    socket.onClose = (reason: string, willReconnect: boolean) => {
      this.#connected = false;
      if (!willReconnect) {
        this.#lastError = reason;
        this.#peers.clear();
      }
    };
    this.#socket = socket;
    this.#running = true;
    this.#lastError = null;
    socket.connect();
    return this.info();
  }

  stop(reason = 'host stopped'): CompanionRelayTransportInfo {
    if (this.#socket) {
      if (this.#socket.isOpen && this.#peers.size > 0) {
        this.#send({ t: 'bye', reason }, 0);
      }
      this.#socket.close();
      this.#socket = null;
    }
    this.#peers.clear();
    this.#running = false;
    this.#connected = false;
    this.#secrets = null;
    this.#fullLink = null;
    this.#viewLink = null;
    this.#qrSvgFull = null;
    this.#qrSvgView = null;
    return this.info();
  }

  info(): CompanionRelayTransportInfo {
    return {
      running: this.#running,
      connected: this.#connected,
      ...(this.#running ? { relayUrl: this.#options.relayUrl } : {}),
      ...(this.#secrets ? { roomId: this.#secrets.roomId } : {}),
      ...(this.#fullLink ? { fullLink: this.#fullLink } : {}),
      ...(this.#viewLink ? { viewLink: this.#viewLink } : {}),
      ...(this.#qrSvgFull ? { qrSvgFull: this.#qrSvgFull } : {}),
      ...(this.#qrSvgView ? { qrSvgView: this.#qrSvgView } : {}),
      guestCount: this.#peers.size,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  /**
   * Empurra saída de pane para todos os guests como frame `pty` selado,
   * alimentado pelo mecanismo existente de remote-terminal-streams (frame
   * ORCA base64 com seq/resume). View-only recebe streams normalmente.
   */
  pushPaneOutput(pane: string, sessionId: string, text: string): void {
    if (!this.#running || !this.#socket) return;
    const encoded = encodeRemoteTerminalOutput(sessionId, text);
    this.#send({ t: 'pty', pane, seq: encoded.seq, data: encoded.frameBase64 }, 0);
  }

  #send(frame: CompanionHostFrame, targetPeer: number): void {
    this.#socket?.send(frame, targetPeer);
  }

  #handleControl(msg: RelayControlMessage): void {
    switch (msg.t) {
      case 'peer-joined':
        this.#peers.set(msg.peer, { name: '', helloed: false, canWrite: false });
        break;
      case 'peer-left':
        this.#peers.delete(msg.peer);
        break;
      default:
        // Controle desconhecido: tolerante por contrato da wire.
        break;
    }
  }

  #handleFrame(frame: unknown, fromPeer: number): void {
    const parsed = parseGuestFrame(frame);
    if (!parsed) {
      this.#send({ t: 'error', message: 'malformed frame' }, fromPeer);
      return;
    }
    switch (parsed.t) {
      case 'hello':
        this.#handleHello(parsed, fromPeer);
        break;
      case 'rpc':
        void this.#handleRpc(parsed.rpc, fromPeer);
        break;
    }
  }

  #handleHello(
    frame: Extract<CompanionGuestFrame, { t: 'hello' }>,
    fromPeer: number,
  ): void {
    if (frame.proto !== COMPANION_RELAY_PROTO) {
      this.#send(
        {
          t: 'error',
          message: `protocol mismatch: host speaks v${COMPANION_RELAY_PROTO}, guest sent v${frame.proto}`,
        },
        fromPeer,
      );
      return;
    }
    const secrets = this.#secrets;
    if (!secrets) return;
    const name =
      frame.name.trim().slice(0, MAX_GUEST_NAME_CHARS) || `guest-${fromPeer}`;
    // Verificação timing-safe: sem token válido, o peer é view-only.
    const canWrite = verifyGuestWriteToken(secrets.writeToken, frame.writeToken);
    this.#peers.set(fromPeer, { name, helloed: true, canWrite });
    this.#send(
      {
        t: 'welcome',
        proto: COMPANION_RELAY_PROTO,
        readOnly: !canWrite,
        ...(this.#options.sessionName
          ? { sessionName: this.#options.sessionName }
          : {}),
      },
      fromPeer,
    );
  }

  async #handleRpc(rpc: CompanionRpcRequest, fromPeer: number): Promise<void> {
    const peer = this.#peers.get(fromPeer);
    if (!peer?.helloed) {
      this.#send(
        { t: 'rpc-result', id: rpc.id, ok: false, error: 'hello required' },
        fromPeer,
      );
      return;
    }
    if (rpc.type === 'ping') {
      this.#send(
        { t: 'rpc-result', id: rpc.id, ok: true, result: { pong: true } },
        fromPeer,
      );
      return;
    }
    // Defense in depth: guest view-only tem RPC mutante rejeitado ANTES da
    // policy. A mobile-companion-policy continua decidindo para quem escreve.
    if (!peer.canWrite && !VIEW_ONLY_TYPES.has(rpc.type)) {
      this.#send(
        {
          t: 'rpc-result',
          id: rpc.id,
          ok: false,
          error: 'read-only link: mutating RPCs are disabled',
        },
        fromPeer,
      );
      return;
    }
    const { id: _id, ...rest } = rpc;
    try {
      const result = await this.#options.dispatch(
        { ...rest, type: rpc.type },
        this.#options.scope,
      );
      this.#send({ t: 'rpc-result', id: rpc.id, ok: true, result }, fromPeer);
    } catch (err) {
      this.#send(
        {
          t: 'rpc-result',
          id: rpc.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        fromPeer,
      );
    }
  }
}

function parseGuestFrame(value: unknown): CompanionGuestFrame | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Record<string, unknown>;
  if (frame.t === 'hello') {
    if (typeof frame.proto !== 'number' || typeof frame.name !== 'string') {
      return null;
    }
    if (frame.writeToken !== undefined && typeof frame.writeToken !== 'string') {
      return null;
    }
    return {
      t: 'hello',
      proto: frame.proto,
      name: frame.name,
      ...(typeof frame.writeToken === 'string'
        ? { writeToken: frame.writeToken }
        : {}),
    };
  }
  if (frame.t === 'rpc') {
    const rpc = frame.rpc;
    if (!rpc || typeof rpc !== 'object') return null;
    const req = rpc as Record<string, unknown>;
    if (typeof req.id !== 'string' || typeof req.type !== 'string') return null;
    if (req.id.length === 0 || req.id.length > 128) return null;
    if (req.type.length === 0 || req.type.length > 128) return null;
    return { t: 'rpc', rpc: req as unknown as CompanionRpcRequest };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton de processo (padrão do remote-bridge): um transporte por vez,
// amarrado ao ProjectExecutionScope que o iniciou.
// ═══════════════════════════════════════════════════════════════════════════

let active: CompanionRelayHost | null = null;

function sameScopeCoordinates(
  left: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  right: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): boolean {
  return (
    left.projectId === right.projectId && left.checkoutId === right.checkoutId
  );
}

export async function startCompanionRelayTransport(
  options: CompanionRelayHostOptions,
): Promise<CompanionRelayTransportInfo> {
  if (active) {
    if (!sameScopeCoordinates(active.scope, options.scope)) {
      throw new Error('relay transport belongs to another project checkout');
    }
    return active.info();
  }
  const host = new CompanionRelayHost(options);
  const info = await host.start();
  active = host;
  return info;
}

export function stopCompanionRelayTransport(
  scope?: ProjectExecutionScope,
): CompanionRelayTransportInfo {
  if (!active) {
    return { running: false, connected: false, guestCount: 0 };
  }
  if (scope && !sameScopeCoordinates(active.scope, scope)) {
    throw new Error('relay transport belongs to another project checkout');
  }
  const info = active.stop();
  active = null;
  return info;
}

export function getCompanionRelayTransportInfo(
  scope?: ProjectExecutionScope,
): CompanionRelayTransportInfo {
  if (!active) {
    return { running: false, connected: false, guestCount: 0 };
  }
  if (scope && !sameScopeCoordinates(active.scope, scope)) {
    return { running: false, connected: false, guestCount: 0 };
  }
  return active.info();
}

/** Transporte ativo (para o wiring de push de PTY). Null quando desligado. */
export function getActiveCompanionRelayHost(): CompanionRelayHost | null {
  return active;
}
