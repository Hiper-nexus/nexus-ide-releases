import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Editor document model (Phase 5 foundation).
 * CodeMirror integration is flag-gated; this pure module owns dirty/hash/limits
 * so UI can swap renderers without re-validating security rules.
 *
 * Formal dep eval for CodeMirror 6: MIT, ~packages @codemirror/* — not installed
 * until size/security review signs off (see docs/EDITOR.md). Meanwhile a
 * controlled textarea path may use this model behind feature.editor.codemirror
 * for non-CM features (hash, dirty, size limits, markdown mode state).
 */

export const MAX_EDITOR_BYTES = 1_500_000;
export const MAX_EDITOR_CHARS = 1_200_000;

export const editorDocumentSchema = z
  .object({
    path: z.string().min(1).max(4096),
    content: z.string().max(MAX_EDITOR_CHARS),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    dirty: z.boolean(),
    binary: z.boolean().default(false),
    tooLarge: z.boolean().default(false),
    mode: z.enum(['edit', 'markdown-read']).default('edit'),
    mtimeMs: z.number().nonnegative().optional(),
  })
  .strict();

export type EditorDocument = z.infer<typeof editorDocumentSchema>;

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const b of sample) {
    if (b < 7 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) > 0.3;
}

export function openEditorDocument(input: {
  path: string;
  bytes: Buffer;
  mtimeMs?: number;
  maxBytes?: number;
}): EditorDocument {
  const maxBytes = input.maxBytes ?? MAX_EDITOR_BYTES;
  if (input.bytes.length > maxBytes) {
    return editorDocumentSchema.parse({
      path: input.path,
      content: '',
      contentHash: hashContent(''),
      dirty: false,
      binary: false,
      tooLarge: true,
      mode: 'edit',
      mtimeMs: input.mtimeMs,
    });
  }
  if (isProbablyBinary(input.bytes)) {
    return editorDocumentSchema.parse({
      path: input.path,
      content: '',
      contentHash: hashContent(''),
      dirty: false,
      binary: true,
      tooLarge: false,
      mode: 'edit',
      mtimeMs: input.mtimeMs,
    });
  }
  const content = input.bytes.toString('utf8');
  return editorDocumentSchema.parse({
    path: input.path,
    content,
    contentHash: hashContent(content),
    dirty: false,
    binary: false,
    tooLarge: false,
    mode: looksLikeMarkdown(input.path) ? 'markdown-read' : 'edit',
    mtimeMs: input.mtimeMs,
  });
}

export function applyEdit(
  doc: EditorDocument,
  nextContent: string,
): EditorDocument {
  if (doc.binary || doc.tooLarge) {
    throw new Error('cannot edit binary or oversized file');
  }
  if (nextContent.length > MAX_EDITOR_CHARS) {
    throw new Error('content exceeds editor limit');
  }
  return editorDocumentSchema.parse({
    ...doc,
    content: nextContent,
    dirty: hashContent(nextContent) !== doc.contentHash,
    mode: 'edit',
  });
}

export function markSaved(doc: EditorDocument): EditorDocument {
  return editorDocumentSchema.parse({
    ...doc,
    contentHash: hashContent(doc.content),
    dirty: false,
  });
}

export function detectExternalChange(
  doc: EditorDocument,
  diskBytes: Buffer,
): boolean {
  if (doc.binary || doc.tooLarge) return false;
  return hashContent(diskBytes.toString('utf8')) !== doc.contentHash && !doc.dirty
    ? true
    : hashContent(diskBytes.toString('utf8')) !== doc.contentHash && doc.dirty
      ? true
      : hashContent(diskBytes.toString('utf8')) !== doc.contentHash;
}

export function setMarkdownMode(
  doc: EditorDocument,
  mode: 'edit' | 'markdown-read',
): EditorDocument {
  return editorDocumentSchema.parse({ ...doc, mode });
}

function looksLikeMarkdown(p: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(p);
}

/** Workspace path guard — relative path must stay under root. */
export function assertEditorPathInWorkspace(
  workspaceRoot: string,
  relPath: string,
): string {
  if (relPath.includes('\0') || relPath.startsWith('..') || pathIsAbsolute(relPath)) {
    throw new Error('path outside workspace');
  }
  const resolved = resolveUnder(workspaceRoot, relPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('path outside workspace');
  }
  return resolved;
}

function pathIsAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function resolveUnder(root: string, rel: string): string {
  const parts = rel.split(/[/\\]/).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('path outside workspace');
  return `${root.replace(/[/\\]$/, '')}/${parts.join('/')}`;
}
