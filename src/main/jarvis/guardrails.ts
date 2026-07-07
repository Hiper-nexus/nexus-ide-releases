/**
 * Guardrails for Jarvis agent actions.
 *
 * DESTRUCTIVE_PATTERNS are regexes that match commands the agent should NEVER
 * execute without explicit user confirmation. `requiresConfirmation()` checks
 * whether a given MCP tool invocation needs a native confirmation dialog.
 *
 * Trivial actions (read, list, status, diff) execute immediately.
 * Destructive actions (write, delete, force push, etc.) require confirmation.
 */

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /^rm\s+.*-rf/,
  /\brm\s+-rf\b/,
  /git\s+push\s+.*--force/,
  /git\s+push\s+.*-f\b/,
  /git\s+reset\s+--hard/,
  /^sudo\s/,
  /^dd\s/,
  /\bdrop\s+(table|database)\b/i,
  /\bdelete\s+from\b/i,
  /^chmod\s+777/,
  /^chmod\s+-R\s+777/,
  /^chown\s+-R\b/,
  /\/dev\/null/,
  /mkfs\./,
  /\bformat\s+C:\b/i,
  /^shutdown\b/,
  /^reboot\b/,
  /^kill\s+-9\b/,
  /^docker\s+rm\s+-f\b/,
  /^docker\s+system\s+prune\b/,
  /^kubectl\s+delete\b/,
  /^npm\s+unpublish\b/,
  /\bTRUNCATE\s+(TABLE\s+)?/i,
  /\bALTER\s+TABLE\s+.*\bDROP\b/i,
];

/**
 * Tools that always require confirmation regardless of their arguments.
 * These are inherently destructive or high-impact operations.
 */
const ALWAYS_CONFIRM_TOOLS = new Set([
  'nexus_file_write',
  'nexus_terminal_run',
  'nexus_git_push',
  'nexus_git_commit',
  'nexus_editor_insert',
  'nexus_editor_replace_selection',
]);

/**
 * Tools that are always safe and never require confirmation.
 */
const NEVER_CONFIRM_TOOLS = new Set([
  'nexus_file_read',
  'nexus_file_open',
  'nexus_file_search',
  'nexus_git_status',
  'nexus_git_diff',
  'nexus_git_log',
  'nexus_git_branch_list',
  'nexus_editor_focus',
  'nexus_editor_goto_line',
  'nexus_terminal_kill',
  'nexus_pane_list',
  'nexus_pane_list_providers',
  'nexus_pane_read',
  'nexus_pane_read_many',
  'nexus_pane_wait_idle',
  'nexus_pane_wait_many',
  'nexus_handoff_list',
  'nexus_agent_list',
  'nexus_agent_get',
  'nexus_mission_list',
  'nexus_mission_get',
  'nexus_media_providers',
  'nexus_perf_snapshot',
]);

/**
 * Checks whether a full command string is destructive.
 * Matches against DESTRUCTIVE_PATTERNS.
 */
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Determines whether a given MCP tool invocation requires user confirmation.
 *
 * Logic:
 * 1. Read-only tools → never confirm
 * 2. High-impact tools (file_write, git_push, etc.) → always confirm
 * 3. terminal_run with destructive command → always confirm
 * 4. Everything else → confirm (safety-first default)
 */
export function requiresConfirmation(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  // Normalize: strip nexus_ prefix for consistent matching
  const normalized = toolName.startsWith('nexus_')
    ? toolName.slice('nexus_'.length)
    : toolName;

  // Read-only tools are always safe
  if (NEVER_CONFIRM_TOOLS.has(toolName) || NEVER_CONFIRM_TOOLS.has(`nexus_${normalized}`)) {
    return false;
  }

  // Always-confirm tools
  if (ALWAYS_CONFIRM_TOOLS.has(toolName) || ALWAYS_CONFIRM_TOOLS.has(`nexus_${normalized}`)) {
    return true;
  }

  // For terminal_run, check if the command is destructive
  if (normalized === 'terminal_run') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (isDestructive(command)) {
      return true;
    }
    // Non-destructive terminal commands also need confirmation
    return true;
  }

  // For git_add, git_pull, git_branch_create, git_branch_switch — confirm
  if (
    normalized === 'git_add' ||
    normalized === 'git_pull' ||
    normalized === 'git_branch_create' ||
    normalized === 'git_branch_switch'
  ) {
    return true;
  }

  // Safety-first: unknown tools require confirmation
  return true;
}

/**
 * Get a human-readable description of why a tool requires confirmation.
 */
export function confirmationReason(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (NEVER_CONFIRM_TOOLS.has(toolName)) {
    return 'read-only operation';
  }
  if (toolName === 'nexus_file_write' || toolName === 'file_write') {
    return `write to ${String(args.path ?? 'unknown file')}`;
  }
  if (toolName === 'nexus_terminal_run' || toolName === 'terminal_run') {
    const cmd = typeof args.command === 'string' ? args.command : 'unknown';
    if (isDestructive(cmd)) {
      return `destructive command: ${cmd}`;
    }
    return `run command: ${cmd}`;
  }
  if (toolName === 'nexus_git_push' || toolName === 'git_push') {
    return 'push to remote';
  }
  if (toolName === 'nexus_git_commit' || toolName === 'git_commit') {
    return `commit: ${String(args.message ?? 'no message')}`;
  }
  if (toolName === 'nexus_editor_insert' || toolName === 'editor_insert') {
    return `edit ${String(args.path ?? 'unknown file')}`;
  }
  if (toolName === 'nexus_editor_replace_selection' || toolName === 'editor_replace_selection') {
    return `replace in ${String(args.path ?? 'unknown file')}`;
  }
  return `tool: ${toolName}`;
}