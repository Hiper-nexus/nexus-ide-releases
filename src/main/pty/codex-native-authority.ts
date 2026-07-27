import fs from 'node:fs';
import path from 'node:path';

export type CodexNativeAuthority = 'read-only' | 'workspace-write';

export const CODEX_READ_ONLY_PERMISSION_PROFILE =
  'nexus_governed_read_only';
export const CODEX_WORKSPACE_PERMISSION_PROFILE =
  'nexus_governed_workspace';

export function codexPermissionProfileFor(
  authority: CodexNativeAuthority,
): string {
  return authority === 'workspace-write'
    ? CODEX_WORKSPACE_PERMISSION_PROFILE
    : CODEX_READ_ONLY_PERMISSION_PROFILE;
}

export type CodexGovernedSandboxLaunchMode =
  | 'provider-native'
  | 'outer-process';

/**
 * macOS Seatbelt profiles cannot be nested reliably: a Codex process already
 * launched by `sandbox-exec` receives EPERM when it tries to apply a second
 * Seatbelt policy to `pwd`, `git`, `apply_patch`, etc.
 *
 * Governed Codex therefore always starts inside the Nexus-owned physical
 * process boundary. On Darwin the argv policy disables Codex's inner sandbox;
 * the outer profile is the single filesystem authority inherited by every
 * descendant.
 */
export function codexGovernedSandboxLaunchMode(
  _platform: NodeJS.Platform,
): CodexGovernedSandboxLaunchMode {
  return 'outer-process';
}

function pathBelongsTo(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Seal these values explicitly before applying the outer process boundary so
 * Codex cannot discover the operator HOME/tmp namespaces.
 */
export function sealCodexPrivateProcessEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  runtime: {
    readonly sandboxDir: string;
    readonly processHome: string;
    readonly processTmp: string;
  },
): NodeJS.ProcessEnv {
  const sandboxDir = fs.realpathSync.native(runtime.sandboxDir);
  const processHome = fs.realpathSync.native(runtime.processHome);
  const processTmp = fs.realpathSync.native(runtime.processTmp);
  if (
    !pathBelongsTo(sandboxDir, processHome) ||
    !pathBelongsTo(sandboxDir, processTmp)
  ) {
    throw new Error(
      'governed Codex private HOME or temp escapes its runtime directory',
    );
  }
  return {
    ...env,
    HOME: processHome,
    TMPDIR: processTmp,
    TMP: processTmp,
    TEMP: processTmp,
  };
}
