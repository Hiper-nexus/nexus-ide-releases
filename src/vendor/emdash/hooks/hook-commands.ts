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
//  - Marker NEXUS_HOOK_STATUS (env-assignment prefix on POSIX; on Windows the
//    fixed base64 prefix of the prelude, F-704) separates Nexus-managed
//    entries from user hooks, same role as emdash's EMDASH_HOOK_PORT marker.
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

/**
 * F-704: prelúdio de todo script de hook do Windows. A 1ª linha é o marcador;
 * com ela fixa, o começo do base64 do `-EncodedCommand` também é fixo, e é
 * por ele que a limpeza reconhece o comando (o marcador não pode mais vir
 * num `cmd.exe /d /c echo …&&` — ver makeWindowsPowerShellHookCommand).
 * O resto conserta o que o PowerShell 5.1 fazia: stdin/stdout na página de
 * código do console (acento virava "a?�?�o"), corpo em ISO-8859-1 e a barra
 * de progresso do Invoke-WebRequest (lenta, CLIXML no stderr).
 */
const WINDOWS_HOOK_MARKER_LINE = `$env:${NEXUS_HOOK_MARKER} = '1'`;
const WINDOWS_HOOK_PRELUDE = [
  WINDOWS_HOOK_MARKER_LINE,
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::InputEncoding = New-Object Text.UTF8Encoding $false',
  '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
  "$PSDefaultParameterValues['Invoke-WebRequest:ContentType'] = 'application/json; charset=utf-8'",
].join('; ');

/**
 * Base64 de um prefixo do marcador com nº de caracteres múltiplo de 3 (6
 * bytes UTF-16LE por grupo): é prefixo exato do base64 de qualquer script
 * que comece pelo prelúdio.
 */
export const NEXUS_HOOK_WINDOWS_MARKER = `-EncodedCommand ${Buffer.from(
  WINDOWS_HOOK_MARKER_LINE.slice(0, Math.floor(WINDOWS_HOOK_MARKER_LINE.length / 3) * 3),
  'utf16le',
).toString('base64')}`;

/** Texto de comando (ou de config inteira) que carrega um hook do Nexus. */
export function isNexusHookText(text: string): boolean {
  return text.includes(NEXUS_HOOK_MARKER) || text.includes(NEXUS_HOOK_WINDOWS_MARKER);
}

/** Filter out Nexus-managed entries from a hook array. */
export function filterUserHooks<T>(entries: T[], stringify?: (entry: T) => string): T[] {
  const toStr = stringify ?? JSON.stringify;
  return entries.filter((entry) => !isNexusHookText(toStr(entry)));
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
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time 1.5 ` +
    `--noproxy 127.0.0.1,localhost --output /dev/null -X POST ` +
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

/**
 * F-704: o PowerShell é chamado direto. O antigo `cmd.exe /d /c echo
 * NEXUS_HOOK_STATUS>NUL&&powershell…` quebrava no Claude Code do Windows, que
 * roda hooks pelo Git Bash: o MSYS converte `/d` e `/c` em caminhos, o
 * `cmd.exe` abre interativo, executa o JSON do stdin como comando e o
 * PowerShell recebe corpo vazio — todo hook do Nexus (triagem, delegação,
 * regressão, lembrete do Maestro) chegava ao Main sem payload. Só `-flag`,
 * base64 e o executável: nada que bash, cmd ou CreateProcess reinterpretem.
 */
export function makeWindowsPowerShellHookCommand(script: string): string {
  const encoded = Buffer.from(`${WINDOWS_HOOK_PRELUDE}; ${script}`, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
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
