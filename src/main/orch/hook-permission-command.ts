// Aprovação estruturada (PRV-02) pelo hook `PermissionRequest`. Clone do
// transporte de hook-triage-command.ts: a RESPOSTA do endpoint é a saída do
// hook, então não há `--output /dev/null`. O endpoint só segura a conexão
// quando existe quem responda (card do desktop visível, aparelho conectado) e
// por no máximo APPROVAL_WAIT_MAX_SECONDS; sem respondente, sem URL, com o
// Main fora do ar ou no prazo, sai vazio e o diálogo da TUI — que a sonda
// provou ficar desenhado e aceitando tecla durante a espera — decide.
// Bearer per-pane via $NEXUS_GATE_TOKEN, URL via $NEXUS_HOOK_PERMISSION_URL
// (env do PTY, nunca persistida), marker NEXUS_HOOK_STATUS para o merge
// idempotente. O cabeçalho do provider só escolhe o dialeto da saída.

import type { ApprovalProvider } from '../../shared/approval-decision';
import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

/** Espera padrão do broker (s). Configurável por NEXUS_APPROVAL_WAIT_SECONDS. */
export const APPROVAL_WAIT_DEFAULT_SECONDS = 120;
/** Teto da espera (s): abaixo do transporte, que fica abaixo do timeout do hook. */
export const APPROVAL_WAIT_MAX_SECONDS = 170;
/** `--max-time` do curl: acima da espera máxima. */
export const PERMISSION_HOOK_TRANSPORT_SECONDS = 175;
/** Timeout declarado ao Claude (o padrão dele é 600 s). */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 180;

export function makePermissionHookCommand(
  provider: ApprovalProvider,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_PERMISSION_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_PERMISSION_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN); " +
        `'X-Nexus-Approval-Provider' = '${provider}' ` +
        `} -Body $payload -TimeoutSec ${PERMISSION_HOOK_TRANSPORT_SECONDS}; ` +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time ${PERMISSION_HOOK_TRANSPORT_SECONDS} ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    `-H "X-Nexus-Approval-Provider: ${provider}" ` +
    '--data-binary @- "$NEXUS_HOOK_PERMISSION_URL" || true'
  );
}
