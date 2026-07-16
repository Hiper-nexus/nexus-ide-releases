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

import { requiresHumanConfirmationForTool } from '../orch/mcp-effect-policy';

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
 * Checks whether a full command string is destructive.
 * Matches against DESTRUCTIVE_PATTERNS.
 */
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

const REMOTE_OR_DEPLOY_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)git\s+push\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release|publish)\b/i,
  /(?:^|[;&|]\s*)gh\s+release\s+create\b/i,
  /(?:^|[;&|]\s*)docker\s+push\b/i,
  /(?:^|[;&|]\s*)kubectl\s+(?:apply|create|delete|patch|replace|rollout|scale)\b/i,
  /(?:^|[;&|]\s*)helm\s+(?:install|upgrade|uninstall|rollback)\b/i,
  /(?:^|[;&|]\s*)(?:terraform|tofu)\s+(?:apply|destroy|import)\b/i,
  /(?:^|[;&|]\s*)pulumi\s+(?:up|destroy|import)\b/i,
  /(?:^|[;&|]\s*)(?:vercel|netlify|firebase|wrangler|fly|flyctl|railway|render)\s+(?:deploy|publish|up)\b/i,
  /(?:^|[;&|]\s*)(?:aws|gcloud|az)\b[^\n]*(?:deploy|publish|push|apply|delete|destroy)\b/i,
  /(?:^|[;&|]\s*)ssh\b/i,
  /(?:^|[;&|]\s*)(?:scp|sftp)\b/i,
  /(?:^|[;&|]\s*)rsync\b[^\n]*\b[^\s:]+:/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
];

/**
 * Voice may execute routine local development work without interrupting the
 * user. Only destructive or externally-publishing commands retain the native
 * confirmation boundary.
 */
export function requiresVoiceCommandConfirmation(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return true;
  return (
    isDestructive(normalized) ||
    REMOTE_OR_DEPLOY_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/**
 * Determines whether a given MCP tool invocation requires user confirmation.
 *
 * Effect classification is centralized in mcp-effect-policy. Arguments are
 * used only to explain the risk, never to weaken the policy decision.
 */
export function requiresConfirmation(
  toolName: string,
  _args: Record<string, unknown>,
): boolean {
  return requiresHumanConfirmationForTool(toolName);
}

/**
 * Get a human-readable description of why a tool requires confirmation.
 */
export function confirmationReason(
  toolName: string,
  args: Record<string, unknown>,
): string {
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
  if (toolName === 'nexus_catalog_install' || toolName === 'catalog_install') {
    // M8: spell out that this downloads UNVERIFIED third-party code from the
    // community catalog into ~/.claude, which the coding agent can later run.
    const kind = safeMediaArg(args.kind, 'component');
    const slug = safeMediaArg(args.slug, 'unknown');
    return `INSTALAR ${kind} de terceiro do catálogo (${slug}) em ~/.claude — código não verificado que o agente pode executar`;
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
      ? 'replicate-video|google-video'
      : 'automatic (google-image, openai-image or replicate-image/seedream)',
  );
  const prompt = `prompt (${textLength(args.prompt)} chars)`;
  const image = safeMediaArg(args.imagePath, 'none');
  const refCount = Array.isArray(args.referenceImagePaths)
    ? args.referenceImagePaths.filter((x) => typeof x === 'string').length
    : 0;
  if (kind === 'image') {
    return (
      `generate image via ${provider}; inputs: ${prompt}, image: ${image}` +
      `${refCount > 0 ? `, refs: ${refCount}` : ''}; output: ${output}`
    );
  }
  const endImage = safeMediaArg(args.endImagePath, 'none');
  const model = safeMediaArg(args.model, 'default');
  return (
    `generate video via ${provider} model ${model}; inputs: ${prompt}, ` +
    `start: ${image}, end: ${endImage}` +
    `${refCount > 0 ? `, refs: ${refCount}` : ''}; output: ${output}`
  );
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
