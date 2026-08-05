import type { AgentGateContext } from './gate';
import type { WorkspacePolicy } from '../../shared/workspace-types';
import { isInsidePath } from './workspace-path';

const CONTROL_SEGMENTS = new Set(['.agents', '.codex']);

/**
 * This boundary follows a main-owned provider marker, not PREVC availability.
 * Standard-lane missions may intentionally run without a frozen
 * contextRevision, but their MCP bearer still cannot escape the governed Codex
 * process through a main-owned handler.
 */
export function isGovernedCodexWorker(
  ctx: Pick<
    AgentGateContext,
    'role' | 'missionId' | 'readOnly' | 'governedNativeProvider'
  >,
): boolean {
  return (
    ctx.role === 'worker' &&
    Boolean(ctx.missionId?.trim()) &&
    ctx.readOnly !== true &&
    ctx.governedNativeProvider === 'codex'
  );
}

function canonicalToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/^nexus_/, '');
}

/**
 * These MCP tools execute in a main-owned process, outside the Codex PTY and
 * therefore outside its inherited outer Seatbelt profile. A governed Codex
 * worker retains the equivalent native operations inside the confined PTY.
 */
const OUTER_SANDBOX_BYPASS_TOOLS = new Set([
  'terminal_run',
  'bg_run',
  'git_sync',
  'git_add',
  'git_commit',
  'git_push',
  'git_pull',
  'git_branch_create',
  'git_branch_switch',
]);

export function pathTargetsCodexControlRoot(candidate: string): boolean {
  return candidate
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => CONTROL_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Throws when the workspace policy does not permit a write/mutation.
 * Call before any MCP tool or dispatch that mutates state.
 * On denial the message instructs the user to update workspace settings.
 */
export function assertWorkspacePolicyAllowsWrite(policy: WorkspacePolicy): void {
  if (policy === 'read_only') {
    throw new Error(
      `workspace policy 'read_only' denies writes. ` +
        `Update workspace settings to allow writes.`,
    );
  }
}

/**
 * Throws when the workspace policy does not permit writing to targetPath.
 * Validates both directions: inside the policy → permits; outside → denies.
 *
 * - read_only:      always denies (no writes anywhere)
 * - write_external: always permits (inside + outside workspace root)
 * - default:        permits inside workspace root only (current behaviour)
 */
export function assertWorkspacePolicyAllowsPathWrite(
  policy: WorkspacePolicy,
  workspaceRoot: string,
  targetPath: string,
): void {
  assertWorkspacePolicyAllowsWrite(policy);
  if (policy === 'default' && !isInsidePath(workspaceRoot, targetPath)) {
    throw new Error(
      `workspace policy 'default' denies writes outside the workspace. ` +
        `Update workspace settings to 'write_external'.`,
    );
  }
}

/**
 * Fail closed before an MCP handler can mutate a SkillsWatcher discovery
 * namespace or spawn a process that does not inherit the Codex outer sandbox.
 */
export function assertGovernedWorkspaceControlBoundary(
  ctx: Pick<
    AgentGateContext,
    'role' | 'missionId' | 'readOnly' | 'governedNativeProvider'
  >,
  toolName: string,
  mutationPaths: readonly string[] = [],
): void {
  if (!isGovernedCodexWorker(ctx)) return;

  const canonical = canonicalToolName(toolName);
  if (OUTER_SANDBOX_BYPASS_TOOLS.has(canonical)) {
    throw new Error(
      `governed worker denies ${canonical} outside the inherited Codex process sandbox`,
    );
  }
  const protectedTarget = mutationPaths.find(pathTargetsCodexControlRoot);
  if (protectedTarget !== undefined) {
    throw new Error(
      `governed worker denies mutation of Codex control path ${protectedTarget}`,
    );
  }
}
