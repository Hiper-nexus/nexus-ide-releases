/**
 * worker_done --files-modified evidence.
 *
 * Adapted from stablyai/orca @ 4ec6bbf5884e5bd915b4f49c4602b5e5a88b61ae
 * (preamble worker_done --files-modified contract);
 * Copyright (c) 2026 Lovecast Inc. — MIT License.
 * See third_party/licenses/orca-MIT.txt.
 *
 * A writer that exits with 0 files-modified is NOT a successful delivery
 * unless a real MCP handoff already closed a task. This is the evidence
 * path that left 20stories-e at board 0/20 with 18 files on disk.
 */

import { AsyncProcessGitRunner } from '../runtime/git-command';
import { listChangedMtimeFiles } from './worker-file-walk';

const IGNORE_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.nexus',
  'dist',
  'out',
  '.vite',
]);

export function parseGitPorcelain(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const name = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    if (name) files.push(name);
  }
  return files;
}

export async function collectMtimeChangedFiles(
  cwd: string,
  sinceMs: number,
  maxFiles = 256,
): Promise<string[]> {
  return listChangedMtimeFiles(cwd, sinceMs, {
    maxFiles, maxDepth: 6, maxEntries: 4_000, skipDirectories: IGNORE_DIR_NAMES,
    inclusive: true,
  });
}

export async function collectFilesModified(
  cwd: string,
  sinceMs?: number,
): Promise<string[]> {
  if (!cwd) return [];
  const git = new AsyncProcessGitRunner();
  try {
    const inside = await git.run(cwd, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true, timeoutMs: 3_000,
    });
    if (inside.status === 0 && inside.stdout.trim() === 'true') {
      const result = await git.run(cwd, ['status', '--porcelain'], {
        allowFailure: true, timeoutMs: 5_000,
      });
      if (result.status === 0) {
        if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error('Git evidence exceeds limit');
        return parseGitPorcelain(result.stdout);
      }
    }
  } catch {
    // No Git evidence: use the bounded mtime fallback only with a real baseline.
  }
  return sinceMs != null && Number.isFinite(sinceMs)
    ? collectMtimeChangedFiles(cwd, sinceMs) : [];
}

export type WriterDeliveryDecision = 'advance' | 'ignore';

export function decideWriterDeliveryEvidence(input: {
  readonly filesModified: readonly string[];
  readonly mcpHandoffClosedTask: boolean;
}): WriterDeliveryDecision {
  if (input.mcpHandoffClosedTask) return 'advance';
  if (input.filesModified.length > 0) return 'advance';
  return 'ignore';
}

export function maybeCompleteFastLaneOnDelivery(input: {
  readonly filesModified: readonly string[];
  readonly mcpHandoffClosedTask: boolean;
  readonly sealedCompleted: number;
  readonly sealedTotal: number;
}): { readonly countsAsDelivery: boolean; readonly pronto: boolean } {
  const countsAsDelivery =
    decideWriterDeliveryEvidence(input) === 'advance';
  return {
    countsAsDelivery,
    pronto:
      countsAsDelivery &&
      input.sealedTotal > 0 &&
      input.sealedCompleted >= input.sealedTotal,
  };
}

function coercePathList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      files.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      for (const key of ['path', 'file', 'filename', 'name']) {
        const candidate = rec[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          files.push(candidate.trim());
          break;
        }
      }
    }
  }
  return files;
}

/**
 * worker_done --files-modified (or equivalent) from MCP / nx-mail / artifacts.
 */
export function normalizeFilesModified(input: {
  readonly filesModified?: unknown;
  readonly ['files-modified']?: unknown;
  readonly artifacts?: unknown;
}): string[] {
  const fromArg = coercePathList(
    input.filesModified ?? input['files-modified'],
  );
  if (fromArg.length > 0) return fromArg;
  return coercePathList(input.artifacts);
}
