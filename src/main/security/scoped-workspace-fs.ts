import type { WebContents } from 'electron';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  isInsidePath,
  resolvePathCandidateForScope,
  resolvePathForScope,
  resolveRootForScope,
} from '../orch/workspace-path';

/**
 * Single IPC filesystem contract for Wave modules.
 *
 * No other product-wave / search / memory IPC handler may invent containment
 * with `path.resolve` + `startsWith`. Always go through this adapter.
 */

export function requireScopedRoot(sender: WebContents): {
  readonly scope: ProjectExecutionScope;
  readonly root: string;
} {
  const scope = requireRendererWorkspaceScope(sender);
  const root = resolveRootForScope(scope);
  return { scope, root };
}

/**
 * Resolve a path (relative or absolute) inside the sender's workspace.
 * Follows realpath when the leaf exists (via resolvePathForScope).
 */
export function resolveScopedPath(
  sender: WebContents,
  inputPath: string,
): string {
  const { scope } = requireScopedRoot(sender);
  return resolvePathForScope(scope, inputPath);
}

/**
 * Lexical candidate only (no realpath of leaf). Prefer for open-before-exist
 * write targets; still rejects escapes.
 */
export function resolveScopedPathCandidate(
  sender: WebContents,
  inputPath: string,
): string {
  const { scope } = requireScopedRoot(sender);
  return resolvePathCandidateForScope(scope, inputPath);
}

/**
 * Pure containment helper for unit tests and pure modules (no WebContents).
 * Prefer this over ad-hoc startsWith checks.
 */
export function assertPathInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isInsidePath(resolvedRoot, resolvedTarget)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return resolvedTarget;
}

/**
 * Subdirectory under project root (e.g. `.nexus-memory`). Rejects escapes.
 */
export function resolveSubdirUnderRoot(
  projectRoot: string,
  relativeDir: string,
): string {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error('projectRoot must be absolute');
  }
  if (!relativeDir || relativeDir.includes('\0')) {
    throw new Error('invalid relative directory');
  }
  if (path.isAbsolute(relativeDir)) {
    throw new Error('directory must be relative');
  }
  const normalized = path.normalize(relativeDir);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(path.sep).includes('..')
  ) {
    throw new Error('directory must not escape project');
  }
  const root = path.resolve(projectRoot);
  const full = path.resolve(root, normalized);
  if (!isInsidePath(root, full) || full === root) {
    throw new Error(
      full === root
        ? 'directory must be a subdirectory of project'
        : 'directory escaped project',
    );
  }
  return full;
}
