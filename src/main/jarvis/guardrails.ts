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
  'nexus_file_close',
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
  'nexus_browser_screenshot',
  'nexus_browser_read',
  'nexus_browser_inspect',
  'nexus_browser_wait',
  // This is a bounded, redacted accessibility snapshot. UI interaction stays
  // behind the separately confirmed nexus_ui_action tool.
  'nexus_ui_read',
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
    const envKeys =
      args.env && typeof args.env === 'object' && !Array.isArray(args.env)
        ? Object.keys(args.env as Record<string, unknown>).sort()
        : [];
    const envNote = envKeys.length > 0 ? ` with env: ${envKeys.join(', ')}` : '';
    if (isDestructive(cmd)) {
      return `destructive command: ${cmd}${envNote}`;
    }
    return `run command: ${cmd}${envNote}`;
  }
  if (toolName === 'nexus_git_push' || toolName === 'git_push') {
    return `push to remote ${String(args.remote ?? 'origin')} ` +
      `branch ${String(args.branch ?? 'current')}`;
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
  if (toolName === 'nexus_browser_open' || toolName === 'browser_open') {
    return `open browser target ${safeBrowserTarget(args.url)}`;
  }
  if (toolName === 'nexus_browser_navigate' || toolName === 'browser_navigate') {
    return `navigate browser pane ${String(args.paneId ?? 'unknown')} to ${safeBrowserTarget(args.url)}`;
  }
  if (toolName === 'nexus_browser_click' || toolName === 'browser_click') {
    return `click element ${String(args.ref ?? 'unknown')} in browser pane ${String(args.paneId ?? 'unknown')}`;
  }
  if (toolName === 'nexus_browser_fill' || toolName === 'browser_fill') {
    return `fill element ${String(args.ref ?? 'unknown')} in browser pane ${String(args.paneId ?? 'unknown')}`;
  }
  if (toolName === 'nexus_preview_start' || toolName === 'preview_start') {
    return `serve preview directory ${safeMediaArg(args.dir, 'unknown')}`;
  }
  if (toolName === 'nexus_image_generate' || toolName === 'image_generate') {
    return mediaConfirmation('image', args);
  }
  if (toolName === 'nexus_video_generate' || toolName === 'video_generate') {
    return mediaConfirmation('video', args);
  }
  if (toolName === 'nexus_audio_generate' || toolName === 'audio_generate') {
    return mediaConfirmation('audio', args);
  }
  return `tool: ${toolName}`;
}

function safeMediaArg(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/[\r\n\t\0-\x1f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .slice(0, 160);
}

function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function mediaConfirmation(
  kind: 'image' | 'video' | 'audio',
  args: Record<string, unknown>,
): string {
  const defaultOutput =
    kind === 'image'
      ? 'workspace/generated-<timestamp>.png'
      : kind === 'video'
        ? 'workspace/generated-<timestamp>.mp4'
        : 'workspace/generated-<timestamp>.mp3';
  const output = safeMediaArg(args.outPath, defaultOutput);
  if (kind === 'audio') {
    const provider = safeMediaArg(args.provider, 'elevenlabs');
    return `generate audio via ${provider}; input: text (${textLength(args.text)} chars); output: ${output}`;
  }

  const provider = safeMediaArg(
    args.provider,
    kind === 'video'
      ? 'replicate-video'
      : 'automatic (google-image or openai-image)',
  );
  const prompt = `prompt (${textLength(args.prompt)} chars)`;
  const image = safeMediaArg(args.imagePath, 'none');
  if (kind === 'image') {
    return `generate image via ${provider}; inputs: ${prompt}, image: ${image}; output: ${output}`;
  }
  const endImage = safeMediaArg(args.endImagePath, 'none');
  return `generate video via ${provider}; inputs: ${prompt}, start: ${image}, end: ${endImage}; output: ${output}`;
}

function safeBrowserTarget(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  try {
    const input = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(input);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid URL';
  }
}
