import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import {
  FILES_CHANNELS,
  listDirSchema,
  readFileSchema,
  writeFileSchema,
  type FileNode,
  type FileTreeResult,
  type ReadFileResult,
} from '../../shared/files-types';
import { activeWorkspaceOrNull } from './workspace-store';

/**
 * File explorer backend — sandboxed to the active workspace. Every relPath is
 * resolved against the workspace root and REJECTED if it escapes it (symlinks
 * included via realpath), so the renderer can only touch files inside the
 * folder the user opened.
 */

const MAX_READ_BYTES = 2_000_000;
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'out',
  '.vite',
  '.DS_Store',
]);

/** Resolve a workspace-relative path to an absolute one, or null if it escapes. */
function safeResolve(relPath: string): { abs: string; root: string } | null {
  // Fail-closed: sem workspace aberto NÃO existe sandbox válida — cair para
  // o home dir daria a um renderer comprometido ~/.ssh, ~/.zshrc etc.
  const root = activeWorkspaceOrNull();
  if (!root) return null;
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Guard against symlinks pointing outside the workspace.
  try {
    const realRoot = fs.realpathSync(root);
    const realAbs = fs.realpathSync(abs);
    const realRel = path.relative(realRoot, realAbs);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  } catch {
    // Alvo ainda não existe (arquivo novo): o check lexical acima não pega
    // symlink em diretório PAI. Valide o realpath do pai existente mais
    // próximo antes de permitir a escrita.
    try {
      let parent = path.dirname(abs);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      const realRoot = fs.realpathSync(root);
      const realParent = fs.realpathSync(parent);
      const relParent = path.relative(realRoot, realParent);
      if (relParent.startsWith('..') || path.isAbsolute(relParent)) return null;
    } catch {
      return null;
    }
  }
  return { abs, root };
}

function listDir(relPath: string): FileTreeResult {
  const resolved = safeResolve(relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  try {
    const dirents = fs.readdirSync(resolved.abs, { withFileTypes: true });
    const entries: FileNode[] = dirents
      .filter((d) => !IGNORED.has(d.name))
      .map((d) => ({
        name: d.name,
        relPath: path.posix.join(
          relPath.split(path.sep).join('/'),
          d.name,
        ),
        kind: d.isDirectory() ? ('dir' as const) : ('file' as const),
      }))
      // Directories first, then alphabetical.
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return true; // NUL byte → binary.
  }
  return false;
}

function readFile(relPath: string): ReadFileResult {
  const resolved = safeResolve(relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  try {
    const stat = fs.statSync(resolved.abs);
    if (stat.isDirectory()) return { ok: false, error: 'is a directory' };
    if (stat.size > MAX_READ_BYTES) return { ok: true, tooLarge: true };
    const buffer = fs.readFileSync(resolved.abs);
    if (looksBinary(buffer)) return { ok: true, binary: true };
    return { ok: true, content: buffer.toString('utf8') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
}

function writeFile(relPath: string, content: string): { ok: boolean; error?: string } {
  const resolved = safeResolve(relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  try {
    fs.writeFileSync(resolved.abs, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'write failed' };
  }
}

/**
 * Save pasted/dropped binary data (e.g. an image from the clipboard) into
 * ~/.nexus/dropped and return its absolute path, so it can be injected into a
 * pane's terminal.
 */
function saveDropped(name: string, base64: string): { ok: boolean; path?: string; error?: string } {
  try {
    const dir = path.join(os.homedir(), '.nexus', 'dropped');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'pasted';
    const stamped = `${Date.now().toString(36)}-${safeName}`;
    const file = path.join(dir, stamped);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'save failed' };
  }
}

export function registerFilesIpc(): void {
  ipcMain.handle(FILES_CHANNELS.saveDropped, (_e, raw) => {
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      typeof raw.base64 !== 'string' ||
      raw.base64.length > 20_000_000
    ) {
      return { ok: false, error: 'invalid payload' };
    }
    return saveDropped(raw.name, raw.base64);
  });

  ipcMain.handle(FILES_CHANNELS.list, (_e, raw) => {
    const parsed = listDirSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid path' };
    return listDir(parsed.data.relPath);
  });

  ipcMain.handle(FILES_CHANNELS.read, (_e, raw) => {
    const parsed = readFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid path' };
    return readFile(parsed.data.relPath);
  });

  ipcMain.handle(FILES_CHANNELS.write, (_e, raw) => {
    const parsed = writeFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid payload' };
    return writeFile(parsed.data.relPath, parsed.data.content);
  });
}
