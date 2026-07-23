import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isCurrentProcessRealMissionE2E } from '../../shared/real-mission-e2e';
import type { SpawnAuthoritySource } from '../orch/spawn-authority';

const CLAUDE_MUTATING_NATIVE_TOOLS = [
  'Task',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
] as const;
const CLAUDE_FAMILY_ADAPTERS = new Set(['claude', 'glm', 'longcat']);

export interface NativeEffectAuthority {
  readonly source: SpawnAuthoritySource;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly contextRevision?: string;
  readonly readOnly?: boolean;
  /** Native CLI confinement independent from Nexus MCP delegation authority. */
  readonly nativeReadOnly?: boolean;
}

export interface AutonomousCliPolicyOptions {
  /**
   * Permit an already mission-bound orchestrator to use audited Nexus MCP
   * without a second provider prompt while native filesystem access remains
   * read-only.
   */
  readonly unattendedNexusMcp?: boolean;
}

/**
 * Autoridade nativa de escrita:
 * - worker vinculado a contrato congelado (contextRevision) — como sempre;
 * - usuário direto, sob a escolha explícita de permissão do provider.
 *
 * Orquestradores são delegate-only: planejam, delegam e integram pelas tools
 * Nexus auditadas, mas nunca ganham Bash/Edit/git nativos no checkout base.
 * `readOnly` continua sendo a restrição MCP completa para reviewers; o novo
 * `nativeReadOnly` permite confinar a CLI sem negar a superfície de delegação.
 */
export function requiresReadOnlyNativeAuthority(
  authority: NativeEffectAuthority,
): boolean {
  if (authority.readOnly === true || authority.nativeReadOnly === true) {
    return true;
  }
  // A pane opened directly by the user follows the provider permission choice.
  if (authority.source === 'direct-user') return false;
  if (authority.role === 'orchestrator') return true;
  if (authority.source === 'legacy-squad') return true;
  return authority.role !== 'worker' || !authority.contextRevision;
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

function removeFlagValuePairs(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; ) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      index += 2;
      continue;
    }
    result.push(args[index]!);
    index += 1;
  }
  return result;
}

function declaresEnforceableReadOnly(
  safeArgs: readonly string[],
): boolean {
  if (
    safeArgs.includes('--read-only') ||
    safeArgs.includes('--sandbox=read-only')
  ) {
    return true;
  }
  return safeArgs.some(
    (arg, index) =>
      arg === '--sandbox' && safeArgs[index + 1] === 'read-only',
  );
}

/** Side-effect-free capability probe used before credential or PTY setup. */
export function supportsEnforceableReadOnlyNativeAuthority(
  adapter: CliPtyAdapter,
): boolean {
  const permission = adapter.control?.permission;
  return (
    adapter.id === 'codex' ||
    (adapter.quirks?.mcpAutoload &&
      CLAUDE_FAMILY_ADAPTERS.has(adapter.id) &&
      permission?.arg === '--permission-mode') ||
    declaresEnforceableReadOnly(permission?.safe ?? [])
  );
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
  options: AutonomousCliPolicyOptions = {},
): string[] {
  const permission = adapter.control?.permission;
  const usesNexusOnlyTools = adapter.quirks.mcpAutoload;
  const safeArgs = permission?.safe ?? [];
  // Release-gate workers run in disposable worktrees. Without YOLO they stall
  // on Codex project-trust / approval prompts and fail as "awaiting operator
  // input" before any handoff can exist.
  const releaseGateFullAuto =
    isCurrentProcessRealMissionE2E() &&
    adapter.id === 'codex' &&
    (permission?.yolo?.length ?? 0) > 0
      ? permission!.yolo
      : [];
  const requestedFullAuto =
    releaseGateFullAuto.length > 0
      ? releaseGateFullAuto
      : requestedFullAutoSequence(adapter, currentArgs);

  /*
   * Read-only is an authority boundary, not a provider preference. Resolve it
   * before the writable/full-auto path and return from here so no later YOLO
   * compatibility rule can restore a bypass flag.
   */
  if (readOnly) {
    const declaresReadOnly =
      supportsEnforceableReadOnlyNativeAuthority(adapter);
    const codexConfinement = adapter.id === 'codex';
    const claudeToolConfinement =
      usesNexusOnlyTools &&
      CLAUDE_FAMILY_ADAPTERS.has(adapter.id) &&
      permission?.arg === '--permission-mode';
    if (!declaresReadOnly) {
      throw new Error(
        `adapter ${adapter.id} does not declare enforceable read-only review confinement`,
      );
    }

    let readOnlyArgs = [...currentArgs];
    for (const sequence of permissionSequences(adapter)) {
      readOnlyArgs = removeSequence(readOnlyArgs, sequence);
    }
    appendOnce(readOnlyArgs, safeArgs);

    if (codexConfinement) {
      // The bypass flag disables BOTH approval and sandbox. It must never
      // coexist with a read-only authority, even when the user selected YOLO.
      readOnlyArgs = removeSequence(readOnlyArgs, [
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      readOnlyArgs = removeSequence(readOnlyArgs, [
        '--sandbox',
        'workspace-write',
      ]);
      readOnlyArgs = removeSequence(readOnlyArgs, ['--sandbox', 'read-only']);
      appendOnce(readOnlyArgs, ['--sandbox', 'read-only']);

      if (options.unattendedNexusMcp) {
        const approvalFlag = permission?.arg;
        const automaticApprovalMode = permission?.modes.auto;
        if (
          approvalFlag !== '--ask-for-approval' ||
          automaticApprovalMode !== 'never'
        ) {
          throw new Error(
            'Codex adapter does not declare unattended audited MCP approval',
          );
        }
        readOnlyArgs = removeFlagValuePairs(readOnlyArgs, approvalFlag);
        appendOnce(readOnlyArgs, [approvalFlag, automaticApprovalMode]);
      }
    }

    if (claudeToolConfinement) {
      // Claude-family MCP autoload can stay unattended for Nexus reads without
      // granting native mutation. `--allowedTools mcp__nexus` preserves the
      // audited MCP surface; disallow the native escape hatches explicitly.
      readOnlyArgs = removeSequence(readOnlyArgs, permission?.yolo ?? []);
      // `dontAsk` denies anything not pre-approved instead of prompting. The
      // explicit Nexus allowlist below keeps audited reads zero-click without
      // relying on bypassPermissions.
      for (let index = 0; index < readOnlyArgs.length; ) {
        if (
          readOnlyArgs[index] === permission?.arg &&
          readOnlyArgs[index + 1] !== undefined
        ) {
          readOnlyArgs.splice(index, 2);
          continue;
        }
        index += 1;
      }
      appendOnce(readOnlyArgs, ['--permission-mode', 'dontAsk']);
      appendOnce(readOnlyArgs, ['--allowedTools', 'mcp__nexus']);
      appendOnce(readOnlyArgs, [
        '--disallowedTools',
        ...CLAUDE_MUTATING_NATIVE_TOOLS,
      ]);
    }
    return readOnlyArgs;
  }

  if (
    !usesNexusOnlyTools &&
    safeArgs.length === 0 &&
    requestedFullAuto.length === 0
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

  // Product invariant (always): Claude-family shells (claude/glm/longcat via
  // mcpAutoload) boot full-auto so the interactive "Yes, I accept" dialog never
  // blocks a Nexus pane. Explicit plan/manual/auto/default on the *input* argv
  // stay as chosen (detect before sequences were stripped — strip drops them).
  if (usesNexusOnlyTools && permission?.yolo && permission.yolo.length > 0) {
    const modeArg = permission.arg;
    const restricted = new Set([
      'plan',
      'manual',
      'acceptEdits',
      'default',
      'dontAsk',
    ]);
    let inputRestrictedMode: string | undefined;
    if (modeArg) {
      for (let index = 0; index < currentArgs.length; index += 1) {
        const value = currentArgs[index + 1];
        if (
          currentArgs[index] === modeArg &&
          value !== undefined &&
          restricted.has(value)
        ) {
          inputRestrictedMode = value;
          break;
        }
      }
    }
    // Drop any permission-mode pair left after the sequence strip.
    if (modeArg) {
      for (let index = 0; index < args.length; ) {
        if (args[index] === modeArg && args[index + 1] !== undefined) {
          args.splice(index, 2);
          continue;
        }
        index += 1;
      }
    }
    args = removeSequence(args, safeArgs);
    args = removeSequence(args, permission.yolo);
    if (inputRestrictedMode && modeArg) {
      appendOnce(args, [modeArg, inputRestrictedMode]);
    } else {
      appendOnce(args, permission.yolo);
    }
  }

  if (usesNexusOnlyTools) {
    args.push('--allowedTools', 'mcp__nexus');
  }
  return args;
}
