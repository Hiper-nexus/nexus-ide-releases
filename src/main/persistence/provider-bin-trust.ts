import fs from 'node:fs';
import path from 'node:path';

/**
 * Trust checks for the renderer-supplied provider `binPath` / `extraArgs`
 * (SEC#4). These decide the actual executable and argv the PTY layer runs at
 * spawn, so a compromised renderer could point them at an arbitrary payload.
 * Pure logic (fs/path only, no electron) — provider-config-store wraps a native
 * confirmation dialog around it before persisting any NEW value.
 */

export interface BinValidation {
  ok: boolean;
  error?: string;
}

/** A binPath is only acceptable if it is an absolute path to an existing,
 * executable file — never a bare name resolved against PATH. */
export function validateBinPath(binPath: string): BinValidation {
  if (!path.isAbsolute(binPath)) {
    return { ok: false, error: 'o caminho do binário deve ser absoluto' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return { ok: false, error: 'arquivo não encontrado' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'o caminho não aponta para um arquivo' };
  }
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
  } catch {
    return { ok: false, error: 'o arquivo não é executável' };
  }
  return { ok: true };
}

export interface SensitiveChange {
  /** A new, non-empty binPath differing from the stored one. */
  binPath?: string;
  /** New, non-empty extraArgs differing from the stored ones. */
  extraArgs?: string[];
}

/**
 * What in this patch is security-sensitive versus the currently-stored config.
 * Only a CHANGE to a non-empty value needs confirmation — clearing a value
 * (→ '' / []) or re-saving the same value never prompts.
 */
export function sensitiveChanges(
  patch: { binPath?: string; extraArgs?: string[] },
  current: { binPath: string; extraArgs: string[] },
): SensitiveChange {
  const change: SensitiveChange = {};
  if (
    patch.binPath !== undefined &&
    patch.binPath.trim() !== '' &&
    patch.binPath !== current.binPath
  ) {
    change.binPath = patch.binPath;
  }
  if (
    patch.extraArgs !== undefined &&
    patch.extraArgs.length > 0 &&
    JSON.stringify(patch.extraArgs) !== JSON.stringify(current.extraArgs)
  ) {
    change.extraArgs = patch.extraArgs;
  }
  return change;
}

export function hasSensitiveChange(change: SensitiveChange): boolean {
  return change.binPath !== undefined || change.extraArgs !== undefined;
}
