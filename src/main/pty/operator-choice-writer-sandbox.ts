import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import type { SquadCliPolicy } from '../../shared/settings-types';
import { createScopedSandboxHome } from '../runtime/process-sandbox';
import { linkedWorktreeGitPaths } from '../runtime/linked-worktree-git-paths';

/**
 * Operator-choice writable workers: any builtin CLI may mutate its isolated
 * worktree. The jail is the Nexus Seatbelt (writable execution root + private
 * session HOME), not a Codex-only allowlist.
 */

export function isOperatorChoiceWorkspaceWrite(input: {
  readonly squadCliPolicy: SquadCliPolicy | string | undefined;
  readonly adapterId: string;
  readonly writableWorkerIntent: boolean;
  readonly hasCodexNativeWriteAuthority: boolean;
}): boolean {
  return (
    isOperatorChoicePolicy(input.squadCliPolicy) &&
    input.writableWorkerIntent &&
    !input.hasCodexNativeWriteAuthority &&
    input.adapterId.trim().length > 0
  );
}

function existingDirectory(candidate: string | undefined): string | null {
  if (!candidate || !candidate.trim()) return null;
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function existingFile(candidate: string): string | null {
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export interface OperatorChoiceWriterSandbox {
  readonly sandboxDir: string;
  readonly extraWritePaths: readonly string[];
  readonly processHome?: string;
  readonly providerStateReadPaths: readonly string[];
  readonly providerStateWritePaths: readonly string[];
}

export interface OperatorChoiceWriterSandboxPlan {
  readonly sandbox: OperatorChoiceWriterSandbox;
  readonly readOnlyRoot: false;
  readonly sandboxProfile: 'workspace-net';
  readonly worktreeGit: ReturnType<typeof linkedWorktreeGitPaths>;
}

/**
 * Resolve the private runtime + Seatbelt grants for an operator-choice writer.
 * Returns null when the boundary cannot be built (caller must fail closed).
 */
export function resolveOperatorChoiceWriterSandbox(input: {
  readonly adapterId: string;
  readonly sessionId: string;
  readonly binaryPath: string;
  readonly rootRealPath: string;
  readonly spawnEnv: Readonly<Record<string, string | undefined>>;
  readonly decorationSandboxDir?: string;
  readonly decorationProcessHome?: string;
  readonly decorationOverrodeHome: boolean;
  readonly providerStateReadPaths?: readonly string[];
  readonly providerStateWritePaths?: readonly string[];
}): OperatorChoiceWriterSandboxPlan | null {
  const realHome = os.homedir();
  let runtimeDir = input.decorationSandboxDir;
  let processHome = input.decorationProcessHome;
  const ephemeralGrants: string[] = [];
  const readOnlyGrants: string[] = [];
  if (!runtimeDir && !input.decorationOverrodeHome) {
    const runtime = createScopedSandboxHome({
      projectId: input.sessionId,
      checkoutId: `writer-${input.adapterId}`,
    });
    runtimeDir = runtime.dir;
    processHome = processHome ?? input.spawnEnv.HOME ?? realHome;
    const ephemeralRoot = path.join(realHome, '.nexus', 'ephemeral');
    for (const envVar of [
      'KIMI_CODE_HOME',
      'GROK_HOME',
      'OPENCODE_CONFIG_DIR',
      'XDG_DATA_HOME',
      'GEMINI_CLI_HOME',
    ]) {
      const value = input.spawnEnv[envVar];
      if (!value || !path.isAbsolute(value)) continue;
      let real: string;
      try {
        real = fs.realpathSync.native(value);
      } catch {
        continue;
      }
      try {
        if (
          real.startsWith(`${ephemeralRoot}${path.sep}`) &&
          fs.statSync(real).isDirectory()
        ) {
          ephemeralGrants.push(real);
        }
      } catch {
        // skip missing grant targets
      }
    }
  }
  if (processHome) {
    const keychainsDir = path.join(realHome, 'Library', 'Keychains');
    try {
      if (fs.statSync(keychainsDir).isDirectory()) {
        readOnlyGrants.push(keychainsDir);
      }
    } catch {
      // no keychain dir
    }
  }

  const sandboxDir =
    existingDirectory(runtimeDir) ??
    existingDirectory(input.spawnEnv.HOME);
  if (!sandboxDir) return null;
  if (!existingFile(input.binaryPath)) return null;

  const extraWritePaths: string[] = [];
  const tmp = existingDirectory(input.spawnEnv.TMPDIR);
  if (tmp && !tmp.startsWith(`${sandboxDir}/`) && tmp !== sandboxDir) {
    extraWritePaths.push(tmp);
  }
  const resolvedProcessHome = existingDirectory(processHome) ?? undefined;
  const providerStateReadPaths: string[] = [];
  for (const candidate of [
    ...(input.providerStateReadPaths ?? []),
    ...ephemeralGrants,
    ...readOnlyGrants,
  ]) {
    const real = existingDirectory(candidate);
    if (real) providerStateReadPaths.push(real);
  }
  const providerStateWritePaths: string[] = [];
  for (const candidate of [
    ...(input.providerStateWritePaths ?? []),
    ...ephemeralGrants,
  ]) {
    const real = existingDirectory(candidate);
    if (real) providerStateWritePaths.push(real);
  }

  const sandbox: OperatorChoiceWriterSandbox = Object.freeze({
    sandboxDir,
    extraWritePaths: Object.freeze(extraWritePaths),
    ...(resolvedProcessHome ? { processHome: resolvedProcessHome } : {}),
    providerStateReadPaths: Object.freeze(providerStateReadPaths),
    providerStateWritePaths: Object.freeze(providerStateWritePaths),
  });

  if (process.platform !== 'darwin') return null;
  return Object.freeze({
    sandbox,
    readOnlyRoot: false as const,
    sandboxProfile: 'workspace-net' as const,
    worktreeGit: linkedWorktreeGitPaths(input.rootRealPath),
  });
}

export function assertOperatorChoiceWriterConfinement(
  adapterId: string,
  plan: OperatorChoiceWriterSandboxPlan | null,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin') {
    throw new Error(
      `operator-choice workspace write for ${adapterId} requires the Nexus ` +
        `kernel sandbox, which is only available on macOS in this release`,
    );
  }
  if (!plan) {
    throw new Error(
      `operator-choice workspace write for ${adapterId} has no enforceable ` +
        `confinement: the per-session private HOME or the CLI binary is missing`,
    );
  }
}
