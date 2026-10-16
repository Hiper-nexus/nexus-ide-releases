/**
 * Contrato compartilhado do shot-bridge (Nexus Shot → NexusIDE).
 *
 * O Nexus Shot (app de captura, processo separado) entrega arquivos ao IDE
 * via um endpoint HTTP loopback criado pelo main process:
 *
 *   POST http://127.0.0.1:{port}/shot/ingest
 *   header: x-nexus-shot-token: <token aleatório por sessão>
 *   body:   { "type": "ingest", "files": ["<abs path>", ...], "source": "nexus-shot" }
 *   destino opcional: { "targetPaneId": "pane-..." } ou { "target": { "paneId": "pane-..." } }
 *   (`"target": null` = nenhum pane escolhido, entrega padrão)
 *   GET /shot/targets (mesmo token): { "ok": true, "data": { "missions": [...] } }
 *   Alvo explícito indisponível é recusado; sem alvo conserva o foco padrão.
 *   ack:    200 { "ok": true, "received": N }
 *   erro:   4xx { "ok": false, "reason": "<slug>" }
 *
 * Descoberta: o main grava { port, token } em
 * `<userData>/shot-bridge/endpoint.json` (modo 0600) — o Shot lê esse arquivo
 * bem-conhecido em vez de adivinhar porta. Sem arquivo = IDE fora do ar.
 *
 * Aceito: caminho absoluto cujo realpath fica sob ~/Pictures/Nexus Shot ou
 * ~/Movies/Nexus Shot (Windows: C:\…\Pictures|Videos\Nexus Shot; Linux:
 * ~/Videos/Nexus Shot; mais as pastas conhecidas redirecionadas — OneDrive,
 * XDG user-dirs; UNC recusado), arquivo regular, tamanho
 * <= SHOT_FILE_MAX_BYTES. O
 * arquivo NÃO é copiado: já vive num diretório permitido; entregamos apenas
 * os metadados ao renderer ("shot:files-received").
 */

import { z } from 'zod';

/** IDs opacos: jamais caminhos, texto de terminal ou caracteres de controle. */
export const shotTargetIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** Internal Main → renderer binding; never accepted from the Shot request. */
export const shotTargetBindingSchema = z.object({
  paneId: shotTargetIdSchema,
  sessionId: z.string().min(1).max(256),
  workspacePath: z.string().min(1).max(8192),
}).strict();
export type ShotTargetBinding = z.infer<typeof shotTargetBindingSchema>;

export const shotDestinationSchema = z.object({
  targetPaneId: shotTargetIdSchema.optional(),
  // Compatibilidade com o seletor do Shot do PR106. O Shot manda `"target": null`
  // quando nenhum pane foi escolhido: null = sem alvo (entrega padrão), igual a
  // ausente. Recusar virava `invalid-shape` e o Shot mostrava "O NexusIDE recusou
  // os arquivos (fora das pastas do Nexus Shot)". `targetPaneId` segue estrito:
  // só ausente ou um id válido, `null` ali continua recusado.
  target: z.object({ paneId: shotTargetIdSchema }).strict().nullish(),
}).passthrough().refine(
  value => !value.targetPaneId || !value.target || value.targetPaneId === value.target.paneId,
);

export const SHOT_TARGETS_MAX_MISSIONS = 25;
export const SHOT_TARGETS_MAX_PANES_PER_MISSION = 50;
export const SHOT_TARGETS_MAX_TITLE_CHARS = 80;

export interface ShotPaneTarget { id: string; title: string; focused: boolean }
export interface ShotTargetsData {
  missions: { id: string; title: string; panes: ShotPaneTarget[] }[];
}

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
  /** Destino explícito: indisponível nunca cai no pane padrão. */
  targetPaneId?: string;
  /** Main's exact physical destination before the event is queued. */
  targetBinding?: ShotTargetBinding;
}

/** Slugs de erro estáveis do ack (o cliente mapeia para i18n). */
export type ShotIngestRejectReason =
  | 'unauthorized'
  | 'invalid-json'
  | 'invalid-shape'
  | 'target-unavailable'
  | 'too-many-files'
  | 'path-not-absolute'
  | 'path-outside-allowed'
  | 'path-not-found'
  | 'not-a-file'
  | 'file-too-large'
  | 'body-too-large'
  | 'not-found';
