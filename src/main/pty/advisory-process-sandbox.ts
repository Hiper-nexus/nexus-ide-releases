import fs from 'node:fs';

import { supportsAdvisoryParticipationCli } from '../../shared/mission-advisory';

/**
 * Kernel-enforced read-only confinement for advisory CLIs.
 *
 * Codex and Grok ship a read-only profile their own binary enforces, so the
 * scheduler can trust them mechanically. Kimi, Agy, OpenCode, OMP and Claude do
 * not: asking them to stay read-only is a prompt-level promise, which is not a
 * boundary. Nexus therefore stops relying on the provider and applies ITS OWN
 * macOS Seatbelt profile around the process — the same one that already confines
 * governed Codex.
 *
 * Under it the execution scope root is mounted read-only by the kernel, so the
 * CLI physically cannot mutate the workspace no matter what the model decides.
 * The only writable area is the per-session private HOME the MCP overlay already
 * creates for that CLI (auth, session and cache state), and network is denied to
 * every descendant except the CLI binary itself, which must reach its provider.
 *
 * This is a narrowing, never a grant: an advisory CLI that cannot be confined
 * gets no read-only lane at all (see assertAdvisoryConfinement).
 */
export interface AdvisoryProcessSandboxInput {
  readonly adapterId: string;
  /**
   * The mission task runs in a read_only lane. This is the PLAN's decision,
   * not `nativeReadOnly` — the latter means "the provider's own argv confines
   * it", which is exactly what an advisory CLI cannot claim.
   */
  readonly readOnlyLane: boolean;
  /** Per-session private HOME installed by the MCP overlay for this CLI. */
  readonly privateHome: string | undefined;
  /** Per-session private temp directory, when the overlay created one. */
  readonly privateTmp?: string | undefined;
  /** Resolved CLI binary, the single process allowed to use the network. */
  readonly binaryPath: string;
}

export interface AdvisoryProcessSandbox {
  /** Writable session root for the confined process (its private HOME). */
  readonly sandboxDir: string;
  /** Extra existing paths the CLI must persist beyond sandboxDir. */
  readonly extraWritePaths: readonly string[];
  /** Only this executable may open the network. */
  readonly networkAllowedProcessPaths: readonly string[];
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

/**
 * Whether this adapter needs the Nexus-owned sandbox to hold a read-only lane.
 * Codex/Grok answer false: their own binary already enforces the boundary.
 */
export function requiresAdvisoryProcessSandbox(
  adapterId: string,
  readOnlyLane: boolean,
): boolean {
  return readOnlyLane && supportsAdvisoryParticipationCli(adapterId);
}

/**
 * Resolve the confinement for an advisory read-only spawn, or null when this
 * spawn does not need one. Returning null NEVER means "run unconfined" for an
 * advisory CLI — callers must pair this with assertAdvisoryConfinement.
 */
export function resolveAdvisoryProcessSandbox(
  input: AdvisoryProcessSandboxInput,
): AdvisoryProcessSandbox | null {
  if (!requiresAdvisoryProcessSandbox(input.adapterId, input.readOnlyLane)) {
    return null;
  }
  const sandboxDir = existingDirectory(input.privateHome);
  if (!sandboxDir) return null;
  const binary = existingFile(input.binaryPath);
  if (!binary) return null;
  const extraWritePaths: string[] = [];
  const tmp = existingDirectory(input.privateTmp);
  // A temp dir nested in the private HOME is already writable through it.
  if (tmp && !tmp.startsWith(`${sandboxDir}/`) && tmp !== sandboxDir) {
    extraWritePaths.push(tmp);
  }
  return Object.freeze({
    sandboxDir,
    extraWritePaths: Object.freeze(extraWritePaths),
    networkAllowedProcessPaths: Object.freeze([binary]),
  });
}

/**
 * Fail-closed guard: an advisory CLI in a read-only lane must never reach spawn
 * without the kernel boundary. Without this, a missing private HOME would
 * silently downgrade the mission's only confinement to a prompt instruction.
 */
export function assertAdvisoryConfinement(
  adapterId: string,
  readOnlyLane: boolean,
  sandbox: AdvisoryProcessSandbox | null,
  platform: NodeJS.Platform,
): void {
  if (!requiresAdvisoryProcessSandbox(adapterId, readOnlyLane)) return;
  if (platform !== 'darwin') {
    throw new Error(
      `advisory read-only lane for ${adapterId} requires the Nexus kernel ` +
        `sandbox, which is only available on macOS in this release`,
    );
  }
  if (!sandbox) {
    throw new Error(
      `advisory read-only lane for ${adapterId} has no enforceable ` +
        `confinement: the per-session private HOME or the CLI binary is missing`,
    );
  }
}
