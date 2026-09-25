// Conselho de delegação via hook Claude `UserPromptSubmit` (C2, 25/09). Como
// na triagem, a resposta do endpoint É a saída do hook (additionalContext) —
// sem `--output /dev/null`. `--max-time 4` cobre o teto de 2,5 s do Jev mais o
// atraso de retry do judge. Nunca bloqueia: `-sf … || true`.
import {
  NEXUS_HOOK_MARKER,
  makeWindowsPowerShellHookCommand,
} from '../../vendor/emdash/hooks/hook-commands';

export function makeClaudeDelegateHookCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'if (-not $env:NEXUS_HOOK_DELEGATE_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }',
      `$env:${NEXUS_HOOK_MARKER} = '1'`,
      '$payload = [Console]::In.ReadToEnd()',
      'try { $response = Invoke-WebRequest -UseBasicParsing -Method POST ' +
        '-Uri $env:NEXUS_HOOK_DELEGATE_URL ' +
        '-Headers @{ ' +
        "'Content-Type' = 'application/json'; " +
        "'authorization' = ('Bearer ' + $env:NEXUS_GATE_TOKEN) " +
        '} -Body $payload -TimeoutSec 4; ' +
        'if ($response.Content) { Write-Output $response.Content } ' +
        '} catch { exit 0 }',
    ].join('; ');
    return makeWindowsPowerShellHookCommand(script);
  }
  return (
    `${NEXUS_HOOK_MARKER}=1 curl -sf --connect-timeout 0.5 --max-time 4 ` +
    '--noproxy 127.0.0.1,localhost -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
    '--data-binary @- "$NEXUS_HOOK_DELEGATE_URL" || true'
  );
}
