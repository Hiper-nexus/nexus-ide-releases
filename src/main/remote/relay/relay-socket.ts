// Porte de can1357/oh-my-pi@03c48d073
// packages/coding-agent/src/collab/relay-client.ts (MIT) para o pacote `ws`
// (Node). Mesmas constantes de reconexão/backoff/buffer/backpressure.
/**
 * Wrapper WebSocket cliente para uma sala do relay cego.
 *
 * Conecta em `<wsUrl>?role=…`, sela/abre frames AES-GCM e reconecta com
 * backoff exponencial (1s→30s com jitter) em quedas transitórias. Close codes
 * fatais do relay (sala fechada/inexistente, conflito de host, sala cheia) e
 * falha de decriptação NUNCA reconectam.
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

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Máximo de envelopes bufferizados aguardando reconexão; excedente é descartado. */
const MAX_PENDING_SENDS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

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

  constructor(opts: RelaySocketOptions) {
    this.#opts = opts;
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.#ws || this.#retryTimer) return;
    this.#closed = false;
    this.#attempt = 0;
    this.#openSocket();
  }

  send(frame: unknown, targetPeer = 0): void {
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (this.#closed) return;
        const openWs = this.#ws;
        if (openWs && openWs.readyState === WebSocket.OPEN) {
          this.#drainPendingSends(openWs);
        }
        const sealed = await seal(this.#opts.key, frame);
        const envelope = packEnvelope(targetPeer, sealed);
        const ws = this.#ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          if (this.#pendingSends.length > 0) {
            this.#enqueuePendingSend(envelope);
            if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
              this.#drainPendingSends(ws);
            } else {
              this.#scheduleBackpressureDrain(ws);
            }
            return;
          }
          if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
            this.#enqueuePendingSend(envelope);
            this.#scheduleBackpressureDrain(ws);
            return;
          }
          ws.send(envelope);
          return;
        }
        this.#enqueuePendingSend(envelope);
      })
      .catch(() => {
        // Falha de seal/send: frame descartado; nada é logado (payload sigiloso).
      });
  }

  /** Close intencional: cancela retries e suprime reconexão. */
  close(): void {
    const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
    this.#clearRetry();
    this.#clearBackpressureDrain();
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#pendingSends.length = 0;
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

  #enqueuePendingSend(envelope: Uint8Array): void {
    if (this.#pendingSends.length >= MAX_PENDING_SENDS) return;
    this.#pendingSends.push(envelope);
  }

  #drainPendingSends(ws: WebSocket): void {
    while (
      this.#pendingSends.length > 0 &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
    ) {
      const envelope = this.#pendingSends.shift();
      if (!envelope) return;
      ws.send(envelope);
    }
  }

  #scheduleBackpressureDrain(ws: WebSocket): void {
    if (this.#backpressureDrainTimer !== undefined) return;
    this.#backpressureDrainTimer = setTimeout(() => {
      this.#backpressureDrainTimer = undefined;
      this.#sendChain = this.#sendChain
        .then(() => {
          if (this.#closed || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          this.#drainPendingSends(ws);
          if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
        })
        .catch(() => {
          // Drain falhou; próximo send tenta de novo.
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
      if (this.#pendingSends.length > 0) {
        this.#drainPendingSends(ws);
        if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
      }
      this.onOpen?.();
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.#ws !== ws) return;
      this.#handleMessage(ws, data, isBinary);
    });
    ws.on('error', () => {
      // O close pareado carrega o estado acionável; nada a fazer aqui.
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.#ws !== ws) return;
      this.#clearBackpressureDrain();
      this.#ws = null;
      this.#handleClose(code, reason.toString('utf8'));
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
    const fatalReason = FATAL_CLOSE_REASONS[code];
    if (fatalReason !== undefined) {
      this.#closed = true;
      this.#pendingSends.length = 0;
      this.onClose?.(fatalReason, false);
      return;
    }
    this.onClose?.(reason || `connection lost (code ${code})`, true);
    this.#scheduleRetry();
  }

  /** Falha de decriptação: chave errada ou frame corrompido. Nunca reconecta. */
  #failFatal(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetry();
    this.#pendingSends.length = 0;
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

function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
