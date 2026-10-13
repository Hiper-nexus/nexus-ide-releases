/**
 * Vocabulário local do transporte E2E do companion mobile (relay cego).
 *
 * Todos os frames abaixo viajam AES-256-GCM selados dentro do envelope
 * `[4B uint32 BE peerId][sealed payload]` (formato pi-wire, vendorado em
 * `src/vendor/omp/wire/`). O relay nunca vê plaintext; a chave da sala vive
 * apenas no fragmento do link.
 *
 * Este arquivo é dependency-free (types + constantes) para poder ser
 * importado por main, renderer e clientes de teste.
 */

/** Versão do protocolo local; o host rejeita mismatches no hello. */
export const COMPANION_RELAY_PROTO = 1;

/** RPC do companion — mesmo shape das mensagens autenticadas da bridge. */
export interface CompanionRpcRequest {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** Guest → host (dentro do seal). */
export type CompanionGuestFrame =
  | {
      t: 'hello';
      proto: number;
      name: string;
      /**
       * Write token base64url provando posse do link full; ausente em links
       * view. O host marca peers sem token válido como read-only e rejeita
       * RPCs mutantes ANTES da mobile-companion-policy (defense in depth).
       */
      writeToken?: string;
    }
  | { t: 'rpc'; rpc: CompanionRpcRequest };

/** Host → guest (dentro do seal). */
export type CompanionHostFrame =
  | { t: 'welcome'; proto: number; readOnly: boolean; sessionName?: string }
  | { t: 'rpc-result'; id: string; ok: boolean; result?: unknown; error?: string }
  /**
   * Stream de pane: `data` é o frame ORCA terminal-stream-protocol em base64
   * (mesmo mecanismo de remote-terminal-streams usado pela bridge LAN).
   */
  | { t: 'pty'; pane: string; seq: number; data: string }
  | { t: 'bye'; reason: string }
  | { t: 'error'; message: string };

export type CompanionRelayFrame = CompanionGuestFrame | CompanionHostFrame;

/**
 * RPCs permitidos a guests view-only (sem writeToken). Qualquer outro type é
 * rejeitado no transporte, antes da política — a mobile-companion-policy
 * continua sendo a autoridade final para peers com escrita.
 */
export const COMPANION_VIEW_ONLY_RPC_TYPES: readonly string[] = [
  'ping',
  'status',
  'panes.list',
  'pane.read',
  'pane.stream.open',
  'mission.list',
  'ops.snapshot',
];

/** Estado exposto via IPC para a UI (links/QR contêm segredo — nunca logar). */
export interface CompanionRelayTransportInfo {
  running: boolean;
  /** Socket host→relay atualmente aberto. */
  connected: boolean;
  relayUrl?: string;
  roomId?: string;
  /** Link full: `<wss>/r/<roomId>#<base64url(roomKey||writeToken)>`. */
  fullLink?: string;
  /** Link view-only: `<wss>/r/<roomId>#<base64url(roomKey)>`. */
  viewLink?: string;
  /** URL https do PWA que o QR Full codifica (`https://app.nexuside.app/#<fullLink>`). */
  fullWebUrl?: string;
  /** URL https do PWA que o QR View codifica. */
  viewWebUrl?: string;
  /** SVG do QR do link full (pareamento com controle). */
  qrSvgFull?: string;
  /** SVG do QR do link view (espectador). */
  qrSvgView?: string;
  guestCount: number;
  lastError?: string;
  error?: string;
}

export interface CompanionRelayStartRequest {
  /** URL do relay (wss://…; ws:// somente para localhost). Vazio = desligado. */
  relayUrl: string;
}

/** Canais IPC tipados — segue o padrão de REMOTE_CHANNELS. */
export const COMPANION_RELAY_CHANNELS = {
  status: 'remote:relay.status',
  start: 'remote:relay.start',
  stop: 'remote:relay.stop',
} as const;
