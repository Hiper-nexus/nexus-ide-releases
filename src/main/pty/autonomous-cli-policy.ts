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

/**
 * Apply provider permission flags while preserving an explicit full-auto
 * choice for writable panes. Explicit read-only authority always wins.
 */
export function secureAutonomousCliArgs(
  adapter: CliPtyAdapter,
  currentArgs: readonly string[],
  readOnly = false,
): string[] {
  const permission = adapter.control?.permission;
  const usesNexusOnlyTools = adapter.quirks.mcpAutoload;
  const safeArgs = permission?.safe ?? [];
  const requestedYolo = (permission?.yolo ?? []).length > 0 &&
    (permission?.yolo ?? []).every((arg) => currentArgs.includes(arg));
  if (!usesNexusOnlyTools && safeArgs.length === 0 && (!requestedYolo || readOnly)) {
    throw new Error(
      `adapter ${adapter.id} does not declare enforceable autonomous confinement`,
    );
  }

  let args = [...currentArgs];
  for (const sequence of permissionSequences(adapter)) {
    args = removeSequence(args, sequence);
  }
  appendOnce(args, safeArgs);

  // Preserve the user's full-auto choice for writable panes/workers. Explicit
  // read-only authority remains stronger than a provider preference.
  if (requestedYolo && !readOnly) {
    args = removeSequence(args, safeArgs);
    appendOnce(args, permission?.yolo ?? []);
  }

  if (readOnly && !usesNexusOnlyTools) {
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
      args = removeSequence(args, ['--ask-for-approval', 'on-request']);
      args = removeSequence(args, ['--ask-for-approval', 'untrusted']);
      args = removeSequence(args, ['--ask-for-approval', 'on-failure']);
      appendOnce(args, ['--sandbox', 'read-only']);
      appendOnce(args, ['--ask-for-approval', 'never']);
    }
  }

  if (usesNexusOnlyTools) {
    args.push('--allowedTools', 'mcp__nexus');
    args.push('--disallowedTools', ...CLAUDE_NATIVE_TOOLS);
  }
  return args;
}
