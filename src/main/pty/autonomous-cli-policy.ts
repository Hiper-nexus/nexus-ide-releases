import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { SpawnAuthoritySource } from '../orch/spawn-authority';

const CLAUDE_NATIVE_TOOLS = [
  'Task',
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
] as const;

export interface NativeEffectAuthority {
  readonly source: SpawnAuthoritySource;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly contextRevision?: string;
  readonly readOnly?: boolean;
}

/**
 * Only a context-revision-bound worker may write through provider-native
 * tools. Bootstrap/orchestrator panes remain read-only and perform effects
 * through the audited Nexus MCP workflow instead.
 */
export function requiresReadOnlyNativeAuthority(
  authority: NativeEffectAuthority,
): boolean {
  if (authority.readOnly === true) return true;
  // A pane opened directly by the user follows the provider permission choice.
  if (authority.source === 'direct-user') return false;
  return (
    authority.source === 'legacy-squad' ||
    authority.role !== 'worker' ||
    !authority.contextRevision
  );
}

function removeSequence(args: string[], sequence: readonly string[]): string[] {
  if (sequence.length === 0) return args;
  const result: string[] = [];
  for (let index = 0; index < args.length; ) {
    const matches = sequence.every(
      (value, offset) => args[index + offset] === value,
    );
    if (matches) {
      index += sequence.length;
      continue;
    }
    result.push(args[index]);
    index += 1;
  }
  return result;
}

function permissionSequences(adapter: CliPtyAdapter): string[][] {
  const permission = adapter.control?.permission;
  if (!permission) return [];
  const sequences = [permission.yolo, permission.safe ?? []].filter(
    (sequence) => sequence.length > 0,
  );
  if (permission.arg) {
    for (const mode of Object.values(permission.modes)) {
      sequences.push([permission.arg, mode]);
    }
  }
  return sequences.sort((left, right) => right.length - left.length);
}

function appendOnce(args: string[], sequence: readonly string[]): void {
  if (sequence.length === 0) return;
  const alreadyPresent = args.some((_, index) =>
    sequence.every((value, offset) => args[index + offset] === value),
  );
  if (!alreadyPresent) args.push(...sequence);
}

function requestedFullAutoSequence(
  adapter: CliPtyAdapter,
  args: readonly string[],
): readonly string[] {
  const permission = adapter.control?.permission;
  if (!permission) return [];
  if (
    permission.yolo.length > 0 &&
    permission.yolo.every((arg) => args.includes(arg))
  ) {
    return permission.yolo;
  }
  if (!permission.arg) return [];
  for (const mode of ['yolo', 'bypass'] as const) {
    const value = permission.modes[mode];
    if (!value) continue;
    const index = args.findIndex(
      (arg, offset) => arg === permission.arg && args[offset + 1] === value,
    );
    if (index >= 0) return [permission.arg, value];
  }
  return [];
}

/**
 * Apply provider permission flags without silently downgrading an explicit
 * full-auto choice. Squad role/read-only metadata scopes Nexus MCP authority;
 * it must not override the permission mode the user selected for the CLI.
 */
export function secureAutonomousCliArgs(
  adapter: CliPtyAdapter,
  currentArgs: readonly string[],
  readOnly = false,
): string[] {
  const permission = adapter.control?.permission;
  const usesNexusOnlyTools = adapter.quirks.mcpAutoload;
  const safeArgs = permission?.safe ?? [];
  const requestedFullAuto = requestedFullAutoSequence(adapter, currentArgs);
  if (
    !usesNexusOnlyTools &&
    safeArgs.length === 0 &&
    (requestedFullAuto.length === 0 || readOnly)
  ) {
    throw new Error(
      `adapter ${adapter.id} does not declare enforceable autonomous confinement`,
    );
  }

  let args = [...currentArgs];
  for (const sequence of permissionSequences(adapter)) {
    args = removeSequence(args, sequence);
  }
  appendOnce(args, safeArgs);

  // Full-auto is a product/user setting, not a squad-role setting. Keep it for
  // workers, coordinators and reviewers alike. Previously Codex reviewers
  // lost --dangerously-bypass-approvals-and-sandbox here and stopped on every
  // MCP call even though the provider was configured as YOLO.
  if (requestedFullAuto.length > 0) {
    args = removeSequence(args, safeArgs);
    appendOnce(args, requestedFullAuto);
  }

  if (readOnly && !usesNexusOnlyTools && requestedFullAuto.length === 0) {
    const declaresReadOnly = safeArgs.some((arg) =>
      /read[-_ ]?only/i.test(arg),
    );
    if (adapter.id !== 'codex' && !declaresReadOnly) {
      throw new Error(
        `adapter ${adapter.id} does not declare enforceable read-only review confinement`,
      );
    }
    if (adapter.id === 'codex') {
      args = removeSequence(args, ['--sandbox', 'workspace-write']);
      appendOnce(args, ['--sandbox', 'read-only']);
    }
  }

  if (usesNexusOnlyTools) {
    args.push('--allowedTools', 'mcp__nexus');
    if (readOnly) args.push('--disallowedTools', ...CLAUDE_NATIVE_TOOLS);
  }
  return args;
}
