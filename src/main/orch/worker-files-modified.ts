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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function isGitWorkTree(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export function collectMtimeChangedFiles(
  cwd: string,
  sinceMs: number,
  maxFiles = 256,
): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= maxFiles || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        if (IGNORE_DIR_NAMES.has(entry.name)) continue;
      }
      if (IGNORE_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs) {
          found.push(path.relative(cwd, full));
        }
      } catch {
        // skip
      }
    }
  };
  visit(cwd, 0);
  return found;
}

export function collectFilesModified(
  cwd: string,
  sinceMs?: number,
): string[] {
  if (!cwd) return [];
  if (isGitWorkTree(cwd)) {
    try {
      const stdout = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseGitPorcelain(stdout);
    } catch {
      // fall through to mtime
    }
  }
  if (sinceMs != null && Number.isFinite(sinceMs)) {
    return collectMtimeChangedFiles(cwd, sinceMs);
  }
  return [];
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
