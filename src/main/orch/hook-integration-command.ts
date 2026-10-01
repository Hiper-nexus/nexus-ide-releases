// Portão de integração no PreToolUse/Bash (F-234): um `git push`,
// `gh pr create|merge` ou `git merge … main` digitado pelo agente em pane de
// missão passa pelo /hook/integration ANTES de executar — a resposta
// `{"decision":"block","reason":…}` impede o comando. Mesmo transporte do
// portão de regressão: resposta lê-se do corpo, `|| true` nunca quebra o CLI,
// e o endpoint responde `{}` fora do caminho (sessão sem missão, comando não
// integrador, falha de infraestrutura).
import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

/** O portão é só leitura de git + consulta ao ledger: 15 s sobram. */
export const INTEGRATION_HOOK_TRANSPORT_SECONDS = 10;
/** Timeout declarado ao CLI (Claude): acima do transporte. */
export const INTEGRATION_HOOK_TIMEOUT_SECONDS = 15;

export function makeIntegrationHookCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_INTEGRATION_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_INTEGRATION_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN) " +
        `} -Body $payload -TimeoutSec ${INTEGRATION_HOOK_TRANSPORT_SECONDS}; ` +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time ${INTEGRATION_HOOK_TRANSPORT_SECONDS} ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '--data-binary @- "$NEXUS_HOOK_INTEGRATION_URL" || true'
  );
}
