import { z } from 'zod';

/**
 * File explorer (FILES tab) types. Every path is validated in main to stay
 * INSIDE the active workspace root — the renderer can never read or write
 * outside the folder the user opened.
 */

export interface FileNode {
  name: string;
  /** Path relative to the workspace root (posix-style, '' for root). */
  relPath: string;
  kind: 'file' | 'dir';
}

export interface FileTreeResult {
  ok: boolean;
  /** Directory listing for `relPath` (one level; lazy-loaded on expand). */
  entries?: FileNode[];
  error?: string;
}

export interface ReadFileResult {
  ok: boolean;
  content?: string;
  /** True when the file was too large or looks binary (not shown for edit). */
  tooLarge?: boolean;
  binary?: boolean;
  error?: string;
}

export const listDirSchema = z.object({
  relPath: z.string().max(4096).default(''),
});
export const readFileSchema = z.object({ relPath: z.string().min(1).max(4096) });
/** Busca de arquivo por nome (Mod+P da paleta): termos sem caixa, todos no caminho. */
export const searchFilesSchema = z.object({
  query: z.string().trim().min(1).max(256),
});

export interface SearchFilesResult {
  ok: boolean;
  /** Caminhos relativos à raiz do workspace (posix). */
  files?: string[];
  /** A caminhada parou num orçamento (resultados, arquivos, pastas ou tempo). */
  truncated?: boolean;
  error?: string;
}

export const writeFileSchema = z.object({
  relPath: z.string().min(1).max(4096),
  content: z.string().max(5_000_000),
});
/**
 * Drop sem `File`: apps nativos entregam só um `text/uri-list` (`file://…`
 * ou `http(s)://…`). O main lê/baixa e estagia em mission-context.
 */
export const importDroppedUriSchema = z.object({
  uri: z.string().min(1).max(4096),
});

/**
 * HEIC/HEIF → JPEG no Main (o renderer não tem decoder; heic-to é LGPL).
 * Mesmo teto de fonte do renderer: acima disso nem o Main decodifica.
 */
export const HEIC_CONVERT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export type HeicConvertFailureReason = 'too-large' | 'unreadable' | 'unsupported';
export type HeicConvertResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: HeicConvertFailureReason; error: string };

export const FILES_CHANNELS = {
  list: 'files:list',
  read: 'files:read',
  write: 'files:write',
  saveDropped: 'files:saveDropped',
  importMissionAttachment: 'files:importMissionAttachment',
  importDroppedUri: 'files:importDroppedUri',
  clipboardFileUris: 'files:clipboardFileUris',
  convertHeicToJpeg: 'files:convertHeicToJpeg',
  search: 'files:search',
} as const;
