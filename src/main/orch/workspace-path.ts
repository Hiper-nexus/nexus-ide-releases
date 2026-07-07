import fs from 'node:fs';
import path from 'node:path';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';

export function activeWorkspaceRoot(): string {
  const root = activeWorkspaceOrNull();
  if (!root) throw new Error('no workspace open');
  return path.resolve(root);
}

export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(inputPath: string): string {
  const root = activeWorkspaceRoot();
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);
  if (!isInsidePath(root, resolved)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

export function resolveWorkspaceCwd(cwdOverride?: string): string {
  const root = activeWorkspaceRoot();
  const cwd = cwdOverride
    ? path.isAbsolute(cwdOverride)
      ? path.resolve(cwdOverride)
      : path.resolve(root, cwdOverride)
    : root;
  if (!isInsidePath(root, cwd)) {
    throw new Error(`cwd escapes workspace: ${cwdOverride}`);
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwdOverride ?? root}`);
  }
  return cwd;
}
