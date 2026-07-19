// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/hooks.ts
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations (emdash hardcodes its own transport):
//  - Endpoint is OUR gate server loopback: the full URL travels in
//    $NEXUS_HOOK_URL (POST /hook/status on the embedded MCP/gate server)
//    instead of emdash's http://127.0.0.1:$EMDASH_HOOK_PORT/hook.
//  - Auth is the SAME per-pane bearer the MCP gate already mints:
//    `authorization: Bearer $NEXUS_GATE_TOKEN` replaces the X-Emdash-Token /
//    X-Emdash-Pty-Id headers (the token alone identifies the pane).
//  - Event type + CLI flavor travel as X-Nexus-Hook-Event / X-Nexus-Hook-Flavor.
//  - Marker NEXUS_HOOK_STATUS (env-assignment prefix on POSIX, echo prefix on
//    Windows) separates Nexus-managed entries from user hooks, same role as
//    emdash's EMDASH_HOOK_PORT marker.
//  - Commands reference env vars only; no token or port is ever written into
//    a config file (the hook process inherits the PTY spawn env).
// Structure preserved verbatim: curl `|| true`, PowerShell SilentlyContinue +
// base64 EncodedCommand, and the stdin/fixed-body payload split.

import { Buffer } from 'node:buffer';

/** CLI flavors with a native hook protocol we can write declaratively. */
export type NexusHookFlavor = 'claude' | 'codex' | 'kimi' | 'grok';

export type HookCommandOptions = {
  platform?: NodeJS.Platform;
  /** Stamped as the X-Nexus-Hook-Flavor header so the endpoint picks a parser. */
  flavor?: NexusHookFlavor;
};

export const NEXUS_HOOK_MARKER = 'NEXUS_HOOK_STATUS';

/** Filter out Nexus-managed entries from a hook array. */
export function filterUserHooks<T>(entries: T[], stringify?: (entry: T) => string): T[] {
  const toStr = stringify ?? JSON.stringify;
  return entries.filter((entry) => !toStr(entry).includes(NEXUS_HOOK_MARKER));
}

// ── Internal helpers ────────────────────────────────────────────────────────

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type HookPostPayload = 'stdin' | { json: Record<string, string> };

function makePosixHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  flavor: NexusHookFlavor,
): string {
  const payloadPart =
    payload === 'stdin' ? '-d @- ' : `--data-binary '${JSON.stringify(payload.json)}' `;
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf -X POST ` +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    `-H "X-Nexus-Hook-Event: ${eventType}" ` +
    `-H "X-Nexus-Hook-Flavor: ${flavor}" ` +
    payloadPart +
    '"$NEXUS_HOOK_URL" || true'
  );
}

function makeWindowsHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  flavor: NexusHookFlavor,
): string {
  const bodyLine =
    payload === 'stdin'
      ? '$payload = [Console]::In.ReadToEnd()'
      : `$payload = ${quotePowerShellString(JSON.stringify((payload as { json: Record<string, string> }).json))}`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'if (-not $env:NEXUS_HOOK_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
    `$env:${NEXUS_HOOK_MARKER} = '1'`,
    bodyLine,
    'try { Invoke-WebRequest -UseBasicParsing -Method POST ' +
      '-Uri $env:NEXUS_HOOK_URL ' +
      '-Headers @{ ' +
      "'Content-Type' = 'application/json'; " +
      "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN); " +
      `'X-Nexus-Hook-Event' = '${eventType}'; ` +
      `'X-Nexus-Hook-Flavor' = '${flavor}' ` +
      '} -Body $payload | Out-Null } catch { exit 0 }',
  ].join('; ');
  return makeWindowsPowerShellHookCommand(script);
}

export function makeWindowsPowerShellHookCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return (
    `cmd.exe /d /c echo ${NEXUS_HOOK_MARKER}>NUL&&` +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  );
}

/** Post an event with an arbitrary payload, platform-aware. */
export function makeHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  opts: HookCommandOptions = {},
): string {
  const flavor = opts.flavor ?? 'claude';
  return (opts.platform ?? process.platform) === 'win32'
    ? makeWindowsHookPostCommand(eventType, payload, flavor)
    : makePosixHookPostCommand(eventType, payload, flavor);
}

// ── Public command builders ─────────────────────────────────────────────────

/**
 * Standard stdin-piped hook command.
 * The agent pipes the event JSON body through stdin.
 */
export function makeStdinHookCommand(eventType: string, opts: HookCommandOptions = {}): string {
  return makeHookPostCommand(eventType, 'stdin', opts);
}

/**
 * Fixed-body notification hook command.
 * Sends a JSON body with a `notification_type` key (used by Codex-style events).
 */
export function makeNotificationHookCommand(
  notificationType: 'idle_prompt' | 'permission_prompt',
  opts: HookCommandOptions = {},
): string {
  return makeHookPostCommand(
    'notification',
    { json: { notification_type: notificationType } },
    opts,
  );
}
