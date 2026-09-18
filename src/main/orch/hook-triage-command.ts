// Triagem de falha de Bash via hook Claude `PostToolUseFailure` (matcher
// `Bash`). Diferente dos status hooks do emdash (que POSTam e descartam a
// resposta com `--output /dev/null`), AQUI a resposta JSON do endpoint É a
// saída do hook: o Main responde `hookSpecificOutput.additionalContext` e o
// Claude o lê junto ao resultado da tool. Por isso SEM `--output /dev/null`.
// O hook nunca bloqueia: `-sf … || true` e o endpoint responde `{}` quando a
// superfície está desligada — o Claude simplesmente não recebe contexto extra.
// Auth/transporte seguem o mesmo contrato dos status hooks: bearer per-pane
// via $NEXUS_GATE_TOKEN, URL via $NEXUS_HOOK_TRIAGE_URL (env do PTY, nunca
// persistido), marker NEXUS_HOOK_STATUS para o merge idempotente.

import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

/**
 * Comando do hook `PostToolUseFailure` (Claude). O payload do evento chega por
 * stdin (`--data-binary @-`); a resposta do endpoint vai para stdout e vira o
 * output do hook. Timeout 8s > TRIAGE_TIMEOUT_MS interno do Jev (6s).
 */
export function makeClaudeTriageHookCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_TRIAGE_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_TRIAGE_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN) " +
        '} -Body $payload -TimeoutSec 8; ' +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time 8 ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '--data-binary @- "$NEXUS_HOOK_TRIAGE_URL" || true'
  );
}
