import fs from 'node:fs';
import path from 'node:path';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorkspacePolicy } from '../../shared/workspace-types';

function realpathOrThrow(targetPath: string, label: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} cannot be resolved: ${detail}`);
  }
}

export function activeWorkspaceRoot(): string {
  const root = activeWorkspaceOrNull();
  if (!root) throw new Error('no workspace open');
  return realpathOrThrow(path.resolve(root), 'workspace');
}

export function resolveRootForScope(scope: ProjectExecutionScope): string {
  const expected = path.resolve(scope.rootRealPath);
  const actual = realpathOrThrow(expected, 'scoped workspace');
  if (actual !== expected) {
    throw new Error('scoped workspace identity changed on disk');
  }
  if (!fs.statSync(actual).isDirectory()) {
    throw new Error('scoped workspace is not a directory');
  }
  return actual;
}

export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePathInsideRoot(root: string, inputPath: string): string {
  const resolved = resolvePathCandidateInsideRoot(root, inputPath);

  const realTarget = fs.existsSync(resolved)
    ? realpathOrThrow(resolved, 'path')
    : (() => {
        const parent = path.dirname(resolved);
        const realParent = realpathOrThrow(parent, 'path parent');
        return path.join(realParent, path.basename(resolved));
      })();

  if (!isInsidePath(root, realTarget)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return realTarget;
}

function resolvePathCandidateInsideRoot(root: string, inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);
  if (!isInsidePath(root, resolved)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

/**
 * Resolve only the lexical candidate under a stable project root. Filesystem
 * callers that bind validation to an opened descriptor use this instead of
 * following the leaf with realpath before open.
 */
export function resolvePathCandidateForScope(
  scope: ProjectExecutionScope,
  inputPath: string,
): string {
  return resolvePathCandidateInsideRoot(resolveRootForScope(scope), inputPath);
}

export function resolvePathForScope(
  scope: ProjectExecutionScope,
  inputPath: string,
): string {
  return resolvePathInsideRoot(resolveRootForScope(scope), inputPath);
}

export function resolveWorkspacePath(inputPath: string): string {
  return resolvePathInsideRoot(activeWorkspaceRoot(), inputPath);
}

function resolveCwdInsideRoot(root: string, cwdOverride?: string): string {
  const cwd = cwdOverride
    ? path.isAbsolute(cwdOverride)
      ? path.resolve(cwdOverride)
      : path.resolve(root, cwdOverride)
    : root;
  const realCwd = realpathOrThrow(cwd, 'cwd');
  if (!isInsidePath(root, realCwd)) {
    throw new Error(`cwd escapes workspace: ${cwdOverride}`);
  }
  if (!fs.existsSync(realCwd) || !fs.statSync(realCwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwdOverride ?? root}`);
  }
  return realCwd;
}

export function resolveCwdForScope(
  scope: ProjectExecutionScope,
  cwdOverride?: string,
): string {
  return resolveCwdInsideRoot(resolveRootForScope(scope), cwdOverride);
}

export function resolveWorkspaceCwd(cwdOverride?: string): string {
  return resolveCwdInsideRoot(activeWorkspaceRoot(), cwdOverride);
}

/**
 * Resolves a write-target path according to the active workspace policy.
 *
 * - `read_only`:      always throws; no writes are permitted
 * - `write_external`: resolves the path without workspace-containment checks
 * - `default`:        enforces the existing inside-workspace-only constraint
 *
 * On denial the message instructs the user to update workspace settings.
 */
export function resolveWritePathWithPolicy(
  policy: WorkspacePolicy,
  workspaceRoot: string,
  inputPath: string,
): string {
  if (policy === 'read_only') {
    throw new Error(
      `workspace policy 'read_only' denies writes. ` +
        `Update workspace settings to allow writes.`,
    );
  }
  if (policy === 'write_external') {
    return path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(workspaceRoot, inputPath);
  }
  // default: existing inside-workspace-only behaviour
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceRoot, inputPath);
  if (!isInsidePath(workspaceRoot, candidate)) {
    throw new Error(
      `workspace policy 'default' denies writes outside the workspace. ` +
        `Update workspace settings to 'write_external'.`,
    );
  }
  return resolvePathInsideRoot(workspaceRoot, inputPath);
}
