import fs from 'node:fs';

import { supportsAdvisoryParticipationCli } from '../../shared/mission-advisory';

/**
 * Kernel-enforced read-only confinement for advisory CLIs.
 *
 * Codex and Grok ship a read-only profile their own binary enforces, so the
 * scheduler can trust them mechanically. Kimi, Agy, OpenCode and Claude do
 * not: asking them to stay read-only is a prompt-level promise, which is not a
 * boundary. Nexus therefore stops relying on the provider and applies ITS OWN
 * macOS Seatbelt profile around the process — the same one that already confines
 * governed Codex.
 *
 * Under it the execution scope root is mounted read-only by the kernel, so the
 * CLI physically cannot mutate the workspace no matter what the model decides.
 * The only writable area is the per-session private HOME the MCP overlay already
 * creates for that CLI (auth, session and cache state).
 *
 * WRITE is the boundary that matters here; the network deliberately stays open.
 * An advisor is routinely asked to go read the reference the operator dropped
 * mid-mission — a page, a doc, an example — and clamping the network would push
 * that work back to the human without protecting the workspace any further.
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
  /**
   * Explicit process HOME for providers whose binary resolves auth/config
   * from the native profile path regardless of $HOME (AGY 1.1). When present
   * the child keeps its native HOME; the sandbox runtime stays private.
   */
  readonly processHome?: string | undefined;
  /**
   * Private writable runtime directory, when the decoration created one
   * separately from the overlay HOME (native-profile spawns). Falls back to
   * privateHome when absent.
   */
  readonly runtimeDir?: string | undefined;
  /** Exact provider-state paths the confined CLI may read. */
  readonly providerStateReadPaths?: readonly string[];
  /** Exact provider-state paths the confined CLI may update. */
  readonly providerStateWritePaths?: readonly string[];
}

export interface AdvisoryProcessSandbox {
  /** Writable session root for the confined process (its private runtime). */
  readonly sandboxDir: string;
  /** Extra existing paths the CLI must persist beyond sandboxDir. */
  readonly extraWritePaths: readonly string[];
  /** Native HOME kept for the child, when the provider requires it. */
  readonly processHome?: string;
  /** Canonical provider-state read grants (never the full user home). */
  readonly providerStateReadPaths: readonly string[];
  /** Canonical provider-state write grants (never the full user home). */
  readonly providerStateWritePaths: readonly string[];
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
  // Native-profile providers (AGY 1.1) keep the real HOME and get a separate
  // private runtime; overlay providers keep HOME == sandboxDir.
  const sandboxDir =
    existingDirectory(input.runtimeDir) ?? existingDirectory(input.privateHome);
  if (!sandboxDir) return null;
  const binary = existingFile(input.binaryPath);
  if (!binary) return null;
  const extraWritePaths: string[] = [];
  const tmp = existingDirectory(input.privateTmp);
  // A temp dir nested in the private HOME is already writable through it.
  if (tmp && !tmp.startsWith(`${sandboxDir}/`) && tmp !== sandboxDir) {
    extraWritePaths.push(tmp);
  }
  const processHome = existingDirectory(input.processHome) ?? undefined;
  // Provider-state grants are canonicalized existing paths. A missing grant
  // target is dropped (not fatal): the CLI may still work from cache, and the
  // kernel boundary is what matters — but the full user home is never added.
  const providerStateReadPaths: string[] = [];
  for (const candidate of input.providerStateReadPaths ?? []) {
    const real = existingDirectory(candidate);
    if (real) providerStateReadPaths.push(real);
  }
  const providerStateWritePaths: string[] = [];
  for (const candidate of input.providerStateWritePaths ?? []) {
    const real = existingDirectory(candidate);
    if (real) providerStateWritePaths.push(real);
  }
  return Object.freeze({
    sandboxDir,
    extraWritePaths: Object.freeze(extraWritePaths),
    ...(processHome ? { processHome } : {}),
    providerStateReadPaths: Object.freeze(providerStateReadPaths),
    providerStateWritePaths: Object.freeze(providerStateWritePaths),
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
