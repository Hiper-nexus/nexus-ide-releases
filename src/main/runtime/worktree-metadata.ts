/**
 * Isolated Git Worktree Provenance Metadata.
 *
 * Distilled from getpaseo/paseo packages/server/src/utils/worktree-metadata.ts (Apache-2.0).
 * Persists mission/task provenance inside `.git/nexus/worktree.json` so worktree
 * state is self-describing, verifiable across reboots, and cleanable on merge.
 *
 * NOT WIRED: no production call site reaches this module, so
 * `.git/nexus/worktree.json` is never written by a running app. The only
 * importer is mission-worktree-orchestrator.ts, which is itself unwired.
 * See docs/qa/items/F-404.md before depending on this metadata.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeProvenanceMetadata {
  readonly version: 1;
  readonly baseRefName: string;
  readonly branchName: string;
  readonly missionId: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly createdAt: string;
  readonly autoArchiveOnMerge?: boolean;
}

export function resolveGitDir(worktreeDir: string): string {
  const dotGit = path.join(worktreeDir, '.git');
  if (!fs.existsSync(dotGit)) {
    throw new Error(`not a git repository or worktree: ${worktreeDir}`);
  }

  const stat = fs.lstatSync(dotGit);
  if (stat.isDirectory()) {
    return dotGit;
  }

  if (stat.isFile()) {
    const content = fs.readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/mu.exec(content.trim());
    if (match?.[1]) {
      const raw = match[1].trim();
      return path.isAbsolute(raw) ? raw : path.resolve(worktreeDir, raw);
    }
  }

  throw new Error(`unable to resolve gitdir for worktree: ${worktreeDir}`);
}

export function getWorktreeMetadataPath(worktreeDir: string): string {
  const gitDir = resolveGitDir(worktreeDir);
  return path.join(gitDir, 'nexus', 'worktree.json');
}

export function writeWorktreeMetadata(
  worktreeDir: string,
  data: {
    baseRefName: string;
    branchName: string;
    missionId: string;
    taskId?: string;
    taskTitle?: string;
    createdAt?: string;
    autoArchiveOnMerge?: boolean;
  },
): WorktreeProvenanceMetadata {
  const meta: WorktreeProvenanceMetadata = {
    version: 1,
    baseRefName: data.baseRefName.trim(),
    branchName: data.branchName.trim(),
    missionId: data.missionId.trim(),
    ...(data.taskId ? { taskId: data.taskId.trim() } : {}),
    ...(data.taskTitle ? { taskTitle: data.taskTitle.trim() } : {}),
    createdAt: data.createdAt ?? new Date().toISOString(),
    autoArchiveOnMerge: data.autoArchiveOnMerge ?? true,
  };

  const metadataPath = getWorktreeMetadataPath(worktreeDir);
  const targetDir = path.dirname(metadataPath);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  const tempFile = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(meta, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempFile, metadataPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Ignore secondary error during cleanup
    }
    throw err;
  }

  return meta;
}

export function readWorktreeMetadata(
  worktreeDir: string,
): WorktreeProvenanceMetadata | null {
  try {
    const metadataPath = getWorktreeMetadataPath(worktreeDir);
    if (!fs.existsSync(metadataPath)) return null;

    const raw = fs.readFileSync(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      typeof parsed.baseRefName === 'string' &&
      typeof parsed.branchName === 'string' &&
      typeof parsed.missionId === 'string'
    ) {
      return Object.freeze(parsed as WorktreeProvenanceMetadata);
    }
    return null;
  } catch {
    return null;
  }
}
