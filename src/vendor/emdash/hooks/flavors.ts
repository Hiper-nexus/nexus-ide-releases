// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Sources: packages/plugins/src/agents/impl/{claude,codex,kimi,grok}/hooks.ts
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations:
//  - The four per-plugin modules are consolidated here as pure spec tables
//    (hookKey -> command) + parseHookEvent functions. Emdash's PluginFs
//    read/write/delete lifecycle, legacy hooks.json migration and Codex
//    `notify` cleanup are NOT vendored — Nexus rewrites its own per-session
//    configs at spawn time (src/main/orch/hook-status-config.ts), so there is
//    no on-disk user-file migration to perform.
//  - Commands come from the Nexus-adapted builders in ./hook-commands
//    (loopback gate endpoint + per-pane bearer), not emdash's transport.
//  - Codex gains a UserPromptSubmit -> start spec (emdash wires only
//    Stop/PermissionRequest/SessionStart); without it a Codex pane could
//    never report `working` semantically. Codex supports UserPromptSubmit
//    hooks (also used by the legacy Nexus hooks.json installer).
//  - Kimi/Grok are covered by the default parser upstream; kept that way.

import type { CanonicalHookEvent } from './hooks-types';
import { defaultHookEventParser, extractProviderSessionId } from './parse-hook-event';
import {
  makeHookPostCommand,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
  type HookCommandOptions,
  type NexusHookFlavor,
} from './hook-commands';

export type { NexusHookFlavor };

export type FlavorHookSpec = {
  /** Native event key in the CLI's hook config (e.g. Claude's UserPromptSubmit). */
  hookKey: string;
  command: string;
};

// ── Claude ──────────────────────────────────────────────────────────────────

/**
 * Claude's Notification events carry no `notification_type` field.
 * Classify by examining the message text:
 *   /permission|approval/i → permission_prompt
 *   everything else        → idle_prompt (agent waiting / done)
 */
export function parseClaudeHookEvent(
  eventType: string,
  body: Record<string, unknown>,
): CanonicalHookEvent {
  if (eventType === 'notification') {
    const message = typeof body.message === 'string' ? body.message : '';
    const notificationType = /permission|approval/i.test(message)
      ? ('permission_prompt' as const)
      : ('idle_prompt' as const);
    return {
      kind: 'status',
      type: 'notification',
      notificationType,
      message: message || undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }

  return defaultHookEventParser(eventType, body);
}

export function claudeHookSpecs(opts: HookCommandOptions = {}): FlavorHookSpec[] {
  const withFlavor = { ...opts, flavor: 'claude' as const };
  return [
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'Notification', command: makeStdinHookCommand('notification', withFlavor) },
    { hookKey: 'Stop', command: makeStdinHookCommand('stop', withFlavor) },
  ];
}

// ── Codex ───────────────────────────────────────────────────────────────────

function makeCodexSessionStartCommand(opts: HookCommandOptions = {}): string {
  const post = makeHookPostCommand('session-start', 'stdin', {
    ...opts,
    flavor: 'codex',
  });
  if ((opts.platform ?? process.platform) === 'win32') return post;
  return `INPUT="\${1:-$(cat)}"; printf '%s' "$INPUT" | ${post}`;
}

/**
 * Codex sends `{ type: 'agent-turn-complete' }` as its stop signal instead
 * of a plain 'stop' event type, and uses fixed `notification_type` values
 * in its hook payloads rather than piping JSON.
 */
export function parseCodexHookEvent(
  eventType: string,
  body: Record<string, unknown>,
): CanonicalHookEvent {
  if (eventType === 'session-start') {
    const candidates = [body.session_id, body.resource_id, body.resourceId, body.sessionId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return { kind: 'session', providerSessionId: candidate.trim() };
      }
    }
    return { kind: 'ignore' };
  }

  if (eventType === 'notification') {
    const nt = body.notification_type;
    if (nt === 'idle_prompt' || (typeof nt !== 'string' && body.type === 'agent-turn-complete')) {
      return { kind: 'status', type: 'stop' };
    }
    if (nt === 'permission_prompt') {
      return { kind: 'status', type: 'notification', notificationType: 'permission_prompt' };
    }
  }

  return defaultHookEventParser(eventType, body);
}

export function codexHookSpecs(opts: HookCommandOptions = {}): FlavorHookSpec[] {
  const withFlavor = { ...opts, flavor: 'codex' as const };
  return [
    { hookKey: 'SessionStart', command: makeCodexSessionStartCommand(opts) },
    // Nexus extension (see header): start signal so Codex panes report working.
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'Stop', command: makeNotificationHookCommand('idle_prompt', withFlavor) },
    {
      hookKey: 'PermissionRequest',
      command: makeNotificationHookCommand('permission_prompt', withFlavor),
    },
  ];
}

// ── Kimi ────────────────────────────────────────────────────────────────────
// Kimi stores hooks as a flat TOML array: `hooks = [{ event, command }]`.

export function kimiHookSpecs(opts: HookCommandOptions = {}): FlavorHookSpec[] {
  const withFlavor = { ...opts, flavor: 'kimi' as const };
  return [
    { hookKey: 'SessionStart', command: makeStdinHookCommand('session', withFlavor) },
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'PostToolUse', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'Notification', command: makeStdinHookCommand('notification', withFlavor) },
    { hookKey: 'Stop', command: makeStdinHookCommand('stop', withFlavor) },
    { hookKey: 'StopFailure', command: makeStdinHookCommand('stop', withFlavor) },
    { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop', withFlavor) },
  ];
}

// ── Grok ────────────────────────────────────────────────────────────────────

function makeGrokSessionStartCommand(opts: HookCommandOptions = {}): string {
  if ((opts.platform ?? process.platform) === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      '$payload = @{ session_id = $env:GROK_SESSION_ID } | ConvertTo-Json -Compress',
      'try { Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN); " +
        "'X-Nexus-Hook-Event' = 'session'; " +
        "'X-Nexus-Hook-Flavor' = 'grok' " +
        '} -Body $payload | Out-Null } catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    'NEXUS_HOOK_STATUS=1 curl -sf -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '-H "X-Nexus-Hook-Event: session" ' +
    '-H "X-Nexus-Hook-Flavor: grok" ' +
    `--data-binary '{"session_id":"'"$GROK_SESSION_ID"'"}' ` +
    '"$NEXUS_HOOK_URL" || true'
  );
}

/**
 * Grok sends Notification events without a notification_type field.
 * All Grok notifications are permission-style prompts.
 */
export function parseGrokHookEvent(
  eventType: string,
  body: Record<string, unknown>,
): CanonicalHookEvent {
  if (eventType === 'notification') {
    return {
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
      message: typeof body.message === 'string' ? body.message : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }
  return defaultHookEventParser(eventType, body);
}

export function grokHookSpecs(opts: HookCommandOptions = {}): FlavorHookSpec[] {
  const withFlavor = { ...opts, flavor: 'grok' as const };
  return [
    { hookKey: 'SessionStart', command: makeGrokSessionStartCommand(opts) },
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'PreToolUse', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'PostToolUse', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('start', withFlavor) },
    { hookKey: 'Notification', command: makeStdinHookCommand('notification', withFlavor) },
    { hookKey: 'Stop', command: makeStdinHookCommand('stop', withFlavor) },
    { hookKey: 'StopFailure', command: makeStdinHookCommand('stop', withFlavor) },
    { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop', withFlavor) },
  ];
}

// ── Flavor dispatch ─────────────────────────────────────────────────────────

/**
 * Route a raw hook event to the right flavor parser. `default` covers flavors
 * without a specialized mapping (and any future CLI speaking the generic
 * event-type superset).
 */
export function parseFlavorHookEvent(
  flavor: NexusHookFlavor | 'default',
  eventType: string,
  body: Record<string, unknown>,
): CanonicalHookEvent {
  switch (flavor) {
    case 'claude':
      return parseClaudeHookEvent(eventType, body);
    case 'codex':
      return parseCodexHookEvent(eventType, body);
    case 'grok':
      return parseGrokHookEvent(eventType, body);
    case 'kimi':
    case 'default':
      return defaultHookEventParser(eventType, body);
  }
}

/** Re-exported for callers that only need the session-id extraction. */
export { extractProviderSessionId };
