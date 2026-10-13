// Porte de can1357/oh-my-pi@03c48d073
// packages/coding-agent/src/collab/relay-client.ts (MIT) para o pacote `ws`
// (Node). O hardening Nexus adiciona fila por bytes, erro observável e
// confirmação de escrita; reconexão/backoff preserva o padrão de origem.
/**
 * Wrapper WebSocket cliente para uma sala do relay cego.
 *
 * Conecta em `<wsUrl>?role=…`, sela/abre frames AES-GCM e reconecta com
 * backoff exponencial (1s→30s com jitter) em quedas transitórias. Close codes
 * fatais do relay (sala fechada/inexistente, conflito de host, sala cheia) e
 * falha de decriptação NUNCA reconectam — exceto 4009 logo depois de uma
 * conexão que já abriu (zumbi do próprio host; ver HOST_CONFLICT_RETRY_WINDOW_MS).
 *
 * NUNCA loga chaves, tokens ou payloads — falhas são reportadas via onClose.
 */
import WebSocket, { type RawData } from 'ws';
import { open, packEnvelope, seal, unpackEnvelope } from '../../../vendor/omp/wire/codec';
import type { RelayControlMessage } from '../../../vendor/omp/wire';

const FATAL_CLOSE_REASONS: Record<number, string> = {
  4001: 'room closed',
  4004: 'no such room',
  4009: 'a host is already connected for this room',
  4029: 'room is full',
};

/**
 * 4009 depois de já ter conectado costuma ser o próprio socket antigo (Wi-Fi
 * caiu, o relay ainda não percebeu): tenta de novo com backoff por até esta
 * janela, que cobre o heartbeat do relay derrubar o zumbi. No 1º connect segue fatal.
 */
const HOST_CONFLICT_RETRY_WINDOW_MS = 2 * 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Limites duplos: quantidade sozinha não protege contra um frame gigante. */
const MAX_PENDING_SENDS = 256;
const MAX_PENDING_SEND_BYTES = 2 * 1024 * 1024;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

export type RelaySocketState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'failed';

export interface RelaySocketOptions {
  /** ws(s)://host[:port]/r/<roomId> — sem query string. */
  wsUrl: string;
  role: 'host' | 'guest';
  key: CryptoKey;
}

export class RelaySocket {
  /** Dispara após cada (re)conexão bem-sucedida. */
  onOpen?: () => void;
  /** Frame já aberto (JSON no boundary — o consumidor valida/casta). */
  onFrame?: (frame: unknown, fromPeer: number) => void;
  onControl?: (msg: RelayControlMessage) => void;
  /** Dispara uma vez por fechamento terminal; willReconnect=true em quedas transitórias. */
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: RelaySocketOptions;
  #ws: WebSocket | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #backpressureDrainTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  /** Estado terminal: close intencional ou falha fatal. Limpo por connect(). */
  #closed = false;
  /** Serializa seal() para os frames irem à wire na ordem de send(). */
  #sendChain: Promise<void> = Promise.resolve();
  /** Serializa open() para os frames serem entregues na ordem de chegada. */
  #recvChain: Promise<void> = Promise.resolve();
  /** Envelopes selados enquanto desconectado, drenados no próximo open. */
  #pendingSends: Uint8Array[] = [];
  #pendingSendBytes = 0;
  #state: RelaySocketState = 'idle';
  #lastError: string | null = null;
  /** Já abriu desde o último connect(); só então 4009 pode ser o próprio zumbi. */
  #openedOnce = false;
  /** Quando a última conexão aberta caiu (null enquanto aberta). */
  #lostAt: number | null = null;

  constructor(opts: RelaySocketOptions) {
    this.#opts = opts;
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Estado observável para UI/telemetria sem expor payload ou chave. */
  get state(): RelaySocketState {
    return this.#state;
  }

  /** Última falha de transporte; limpa quando uma conexão nova abre com sucesso. */
  get lastError(): string | null {
    return this.#lastError;
  }

  get pendingSendCount(): number {
    return this.#pendingSends.length;
  }

  get pendingSendBytes(): number {
    return this.#pendingSendBytes;
  }

  connect(): void {
    if (this.#ws || this.#retryTimer) return;
    this.#closed = false;
    this.#attempt = 0;
    this.#lastError = null;
    this.#openedOnce = false;
    this.#lostAt = null;
    this.#state = 'connecting';
    this.#openSocket();
  }

  send(frame: unknown, targetPeer = 0): void {
    this.#sendChain = this.#sendChain
      .then(() => this.#sendOrdered(frame, targetPeer))
      .catch(() => {
        this.#failFatal('relay send failed; resync required');
      });
  }

  /** Close intencional: cancela retries e suprime reconexão. */
  close(): void {
    const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
    this.#clearRetry();
    this.#clearBackpressureDrain();
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#state = 'closed';
    this.#clearPendingSends();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // Já fechando/fechado.
      }
    }
    if (hadActivity && !wasClosed) this.onClose?.('closed', false);
  }

  async #sendOrdered(frame: unknown, targetPeer: number): Promise<void> {
    if (this.#closed) return;
    const openWs = this.#ws;
    if (openWs && openWs.readyState === WebSocket.OPEN) {
      await this.#drainPendingSends(openWs);
      if (this.#closed) return;
    }

    let envelope: Uint8Array;
    try {
      const sealed = await seal(this.#opts.key, frame);
      envelope = packEnvelope(targetPeer, sealed);
    } catch {
      this.#failFatal('relay send seal failed; resync required');
      return;
    }
    // close()/fatal pode ocorrer enquanto o WebCrypto está selando.
    if (this.#closed) return;

    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.#enqueuePendingSend(envelope);
      return;
    }
    if (this.#pendingSends.length > 0) {
      if (!this.#enqueuePendingSend(envelope)) return;
      if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
        await this.#drainPendingSends(ws);
      } else {
        this.#scheduleBackpressureDrain(ws);
      }
      return;
    }
    if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
      if (!this.#enqueuePendingSend(envelope)) return;
      this.#scheduleBackpressureDrain(ws);
      return;
    }
    await this.#writeEnvelope(ws, envelope);
  }

  #enqueuePendingSend(envelope: Uint8Array): boolean {
    const nextCount = this.#pendingSends.length + 1;
    const nextBytes = this.#pendingSendBytes + envelope.byteLength;
    if (
      nextCount > MAX_PENDING_SENDS ||
      nextBytes > MAX_PENDING_SEND_BYTES
    ) {
      this.#failFatal('relay send queue overflow; resync required');
      return false;
    }
    this.#pendingSends.push(envelope);
    this.#pendingSendBytes = nextBytes;
    return true;
  }

  async #drainPendingSends(ws: WebSocket): Promise<void> {
    while (
      this.#pendingSends.length > 0 &&
      !this.#closed &&
      this.#ws === ws &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
    ) {
      const envelope = this.#pendingSends[0];
      if (!envelope) return;
      await this.#writeEnvelope(ws, envelope);
      if (this.#pendingSends[0] !== envelope) {
        throw new Error('relay send queue order changed');
      }
      this.#pendingSends.shift();
      this.#pendingSendBytes -= envelope.byteLength;
    }
  }

  #writeEnvelope(ws: WebSocket, envelope: Uint8Array): Promise<void> {
    if (
      this.#closed ||
      this.#ws !== ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(new Error('relay socket is no longer writable'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      try {
        ws.send(envelope, (error?: Error) => settle(error));
      } catch (error) {
        settle(error instanceof Error ? error : new Error('relay send failed'));
      }
    });
  }

  #scheduleBackpressureDrain(ws: WebSocket): void {
    if (this.#backpressureDrainTimer !== undefined) return;
    this.#backpressureDrainTimer = setTimeout(() => {
      this.#backpressureDrainTimer = undefined;
      this.#sendChain = this.#sendChain
        .then(async () => {
          if (this.#closed || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          await this.#drainPendingSends(ws);
          if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
        })
        .catch(() => {
          this.#failFatal('relay send failed; resync required');
        });
    }, WS_BACKPRESSURE_DRAIN_RETRY_MS);
  }

  #clearBackpressureDrain(): void {
    if (this.#backpressureDrainTimer !== undefined) {
      clearTimeout(this.#backpressureDrainTimer);
      this.#backpressureDrainTimer = undefined;
    }
  }

  #openSocket(): void {
    this.#clearBackpressureDrain();
    const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.on('open', () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      this.#state = 'open';
      this.#lastError = null;
      this.#openedOnce = true;
      this.#lostAt = null;
      if (this.#pendingSends.length > 0) {
        this.#sendChain = this.#sendChain
          .then(async () => {
            if (this.#closed || this.#ws !== ws) return;
            await this.#drainPendingSends(ws);
            if (this.#pendingSends.length > 0) {
              this.#scheduleBackpressureDrain(ws);
            }
          })
          .catch(() => {
            this.#failFatal('relay send failed; resync required');
          });
      }
      this.onOpen?.();
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.#ws !== ws) return;
      this.#handleMessage(ws, data, isBinary);
    });
    // O close pareado carrega o estado acionável; o erro só explica a queda
    // (ex.: "Unexpected server response: 404" quando o relay não existe).
    let transportError = '';
    ws.on('error', (error: unknown) => {
      transportError = error instanceof Error ? redactRelayUrls(error.message) : '';
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.#ws !== ws) return;
      this.#clearBackpressureDrain();
      this.#ws = null;
      this.#handleClose(code, redactRelayUrls(reason.toString('utf8')) || transportError);
    });
  }

  #handleMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      try {
        this.onControl?.(JSON.parse(toBytes(data).toString()) as RelayControlMessage);
      } catch {
        // Mensagem de controle malformada: ignorada.
      }
      return;
    }
    const envelope = unpackEnvelope(new Uint8Array(toBytes(data)));
    if (!envelope) return;
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#ws !== ws) return;
        let frame: unknown;
        try {
          frame = await open(this.#opts.key, envelope.payload);
        } catch {
          // O host recebe frames de qualquer guest através do relay cego, que os
          // encaminha sem poder verificá-los. Um guest quebrado ou hostil (mesmo
          // view-only) não pode derrubar a sessão inteira com um frame
          // indecifrável: dropamos só aquele frame. Já para o guest, falha de
          // decriptação = chave da sala errada; reconectar não ajuda, então é
          // fatal (semântica original preservada).
          if (this.#opts.role === 'host') return;
          this.#failFatal('bad key or corrupted frame');
          return;
        }
        if (this.#ws !== ws) return;
        this.onFrame?.(frame, envelope.peerId);
      })
      .catch(() => {
        // Handler do consumidor lançou; não derruba a cadeia de recepção.
      });
  }

  #handleClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#clearBackpressureDrain();
    if (this.#openedOnce) this.#lostAt ??= Date.now();
    const fatalReason = FATAL_CLOSE_REASONS[code];
    const ownStaleHost =
      code === 4009 &&
      this.#lostAt !== null &&
      Date.now() - this.#lostAt < HOST_CONFLICT_RETRY_WINDOW_MS;
    if (fatalReason !== undefined && !ownStaleHost) {
      this.#closed = true;
      this.#state = 'failed';
      this.#lastError = fatalReason;
      this.#clearPendingSends();
      this.onClose?.(fatalReason, false);
      return;
    }
    const reconnectReason = ownStaleHost
      ? 'previous connection still holds the room; retrying'
      : reason || `connection lost (code ${code})`;
    this.#state = 'reconnecting';
    this.#lastError = reconnectReason;
    this.onClose?.(reconnectReason, true);
    this.#scheduleRetry();
  }

  /** Falha de decriptação: chave errada ou frame corrompido. Nunca reconecta. */
  #failFatal(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = 'failed';
    this.#lastError = reason;
    this.#clearRetry();
    this.#clearPendingSends();
    const ws = this.#ws;
    this.#ws = null;
    this.#clearBackpressureDrain();
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // Já fechando/fechado.
      }
    }
    this.onClose?.(reason, false);
  }

  #clearPendingSends(): void {
    this.#pendingSends.length = 0;
    this.#pendingSendBytes = 0;
  }

  #scheduleRetry(): void {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt++;
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed) return;
      this.#openSocket();
    }, delay);
    this.#retryTimer.unref?.();
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }
}

/** Motivo vai para a UI: nunca carrega o endereço da sala. */
function redactRelayUrls(message: string): string {
  return message.replace(/\b(?:wss?|https?):\/\/\S+/gi, '<relay>').slice(0, 160);
}

function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
