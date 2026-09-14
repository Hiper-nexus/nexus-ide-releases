$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT' -or (node -p 'process.arch') -ne 'x64') {
  throw 'Windows x64 is required for the Codex smoke prerequisite'
}

$prefix = Join-Path $env:RUNNER_TEMP 'nexus-smoke-cli'
npm install --global --prefix $prefix '@openai/codex@0.145.0'
if ($LASTEXITCODE -ne 0) { throw 'pinned Codex smoke prerequisite install failed' }

$expectedSuffix = '/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
$nativeCandidates = @(
  Get-ChildItem (Join-Path $prefix 'node_modules') -Recurse -File -Filter 'codex.exe' |
    Where-Object {
      $_.FullName.Replace('\', '/').EndsWith(
        $expectedSuffix,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    }
)
if ($nativeCandidates.Count -ne 1) {
  throw "expected one pinned native codex.exe; found $($nativeCandidates.Count)"
}
$nativeCodex = $nativeCandidates[0]
$platformPackageRoot = $nativeCodex.Directory.Parent.Parent.Parent.FullName
$platformPackage = Get-Content (Join-Path $platformPackageRoot 'package.json') -Raw |
  ConvertFrom-Json
if ($platformPackage.name -ne '@openai/codex' -or
    $platformPackage.version -ne '0.145.0-win32-x64') {
  throw 'unexpected Codex Windows platform package identity'
}

$nativeVersion = (& $nativeCodex.FullName --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nativeVersion -ne 'codex-cli 0.145.0') {
  throw "unexpected native Codex prerequisite: $nativeVersion"
}

$env:NEXUS_SMOKE_CODEX_EXE = $nativeCodex.FullName
$probeStdout = Join-Path $env:RUNNER_TEMP 'nexus-codex-pty-probe.stdout.log'
$probeStderr = Join-Path $env:RUNNER_TEMP 'nexus-codex-pty-probe.stderr.log'
$probe = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @('--import', 'tsx', 'scripts/windows-codex-node-pty-probe.ts') `
  -RedirectStandardOutput $probeStdout `
  -RedirectStandardError $probeStderr `
  -NoNewWindow `
  -PassThru
if (-not $probe.WaitForExit(20000)) {
  $probe.Kill()
  $probe.WaitForExit()
  throw 'native Codex node-pty probe exceeded its hard deadline'
}
$probe.WaitForExit()
$probeOutput = if (Test-Path $probeStdout) {
  (Get-Content $probeStdout -Raw).Trim()
} else { '' }
$probeError = if (Test-Path $probeStderr) {
  (Get-Content $probeStderr -Raw).Trim()
} else { '' }
if ($probe.ExitCode -ne 0) {
  throw "native Codex node-pty probe failed: $probeError"
}
Write-Host $probeOutput

$nativeCodex.Directory.FullName |
  Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
