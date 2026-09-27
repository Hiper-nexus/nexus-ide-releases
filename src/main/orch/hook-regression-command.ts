// Portão de regressão no fim do turno (hook `Stop`, Claude e Codex). Como na
// triagem e no /hook/delegate, a resposta do endpoint É a saída do hook: um
// `{"decision":"block","reason":…}` faz o agente continuar com as falhas dos
// testes impactados em vez de encerrar. `--max-time 170` cobre o timeout dos
// testes (120 s) mais o mapa de imports; o hook Claude declara 180 s. Nunca
// quebra o CLI: `-sf … || true` e o endpoint responde `{}` fora do caminho.
import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

export const REGRESSION_HOOK_TIMEOUT_SECONDS = 180;

export function makeRegressionHookCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_REGRESSION_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_REGRESSION_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN) " +
        '} -Body $payload -TimeoutSec 170; ' +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time 170 ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '--data-binary @- "$NEXUS_HOOK_REGRESSION_URL" || true'
  );
}
