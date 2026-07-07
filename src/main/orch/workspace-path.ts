import fs from 'node:fs';
import path from 'node:path';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';

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

export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(inputPath: string): string {
  const root = activeWorkspaceRoot();
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);

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

export function resolveWorkspaceCwd(cwdOverride?: string): string {
  const root = activeWorkspaceRoot();
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
