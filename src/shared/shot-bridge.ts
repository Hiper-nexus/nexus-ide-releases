/**
 * Contrato compartilhado do shot-bridge (Nexus Shot → NexusIDE).
 *
 * O Nexus Shot (app de captura, processo separado) entrega arquivos ao IDE
 * via um endpoint HTTP loopback criado pelo main process:
 *
 *   POST http://127.0.0.1:{port}/shot/ingest
 *   header: x-nexus-shot-token: <token aleatório por sessão>
 *   body:   { "type": "ingest", "files": ["<abs path>", ...], "source": "nexus-shot" }
 *   ack:    200 { "ok": true, "received": N }
 *   erro:   4xx { "ok": false, "reason": "<slug>" }
 *
 * Descoberta: o main grava { port, token } em
 * `<userData>/shot-bridge/endpoint.json` (modo 0600) — o Shot lê esse arquivo
 * bem-conhecido em vez de adivinhar porta. Sem arquivo = IDE fora do ar.
 *
 * Aceito: caminho absoluto cujo realpath fica sob ~/Pictures/Nexus Shot ou
 * ~/Movies/Nexus Shot, arquivo regular, tamanho <= SHOT_FILE_MAX_BYTES. O
 * arquivo NÃO é copiado: já vive num diretório permitido; entregamos apenas
 * os metadados ao renderer ("shot:files-received").
 */

export const SHOT_BRIDGE_CHANNELS = {
  /** event: main → renderer. Arquivos recebidos do Nexus Shot. */
  filesReceived: 'shot:files-received',
} as const;

/** Corpo máximo do POST (JSON com a lista de caminhos). */
export const SHOT_REQUEST_MAX_BYTES = 64 * 1024;
/** Máximo de arquivos por ingest (folga para o pacote de revisão: cap de 300
 *  frames do extrator + vídeo + folha de contato). Espelhado no cliente Rust
 *  do Nexus Shot (lib.rs, expansão de frames). */
export const SHOT_INGEST_MAX_FILES = 320;
/** Tamanho máximo por arquivo (512 MB — vídeos de gravação). */
export const SHOT_FILE_MAX_BYTES = 512 * 1024 * 1024;

export type ShotFileKind = 'image' | 'video' | 'other';

export interface ShotFileMeta {
  /** realpath absoluto validado (sob uma raiz permitida). */
  path: string;
  name: string;
  size: number;
  kind: ShotFileKind;
}

/** Payload do evento shot:files-received (main → renderer). */
export interface ShotFilesReceivedPayload {
  files: ShotFileMeta[];
  source: 'nexus-shot';
  receivedAt: number;
}

/** Slugs de erro estáveis do ack (o cliente mapeia para i18n). */
export type ShotIngestRejectReason =
  | 'unauthorized'
  | 'invalid-json'
  | 'invalid-shape'
  | 'too-many-files'
  | 'path-not-absolute'
  | 'path-outside-allowed'
  | 'path-not-found'
  | 'not-a-file'
  | 'file-too-large'
  | 'body-too-large'
  | 'not-found';
