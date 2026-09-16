$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT' -or (node -p 'process.arch') -ne 'x64') {
  throw 'Windows x64 is required for the Codex smoke prerequisite'
}

$scratchRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  $env:RUNNER_TEMP
} elseif (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
  $env:TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$prefix = Join-Path $scratchRoot 'nexus-smoke-cli'
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
$probeStdout = Join-Path $scratchRoot 'nexus-codex-pty-probe.stdout.log'
$probeStderr = Join-Path $scratchRoot 'nexus-codex-pty-probe.stderr.log'
$probe = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @('--import', 'tsx', 'scripts/windows-codex-node-pty-probe.ts') `
  -WorkingDirectory (Get-Location).Path `
  -RedirectStandardOutput $probeStdout `
  -RedirectStandardError $probeStderr `
  -NoNewWindow `
  -PassThru
$probeHandle = $probe.SafeHandle
if ($probeHandle.IsInvalid -or $probeHandle.IsClosed) {
  throw 'native Codex node-pty probe process handle is unavailable'
}
if (-not $probe.WaitForExit(20000)) {
  $probe.Kill()
  if (-not $probe.WaitForExit(5000)) {
    throw 'native Codex node-pty probe did not exit after targeted termination'
  }
  throw 'native Codex node-pty probe exceeded its hard deadline'
}
$probeOutput = ''
if (Test-Path $probeStdout) {
  $probeOutputContent = Get-Content $probeStdout -Raw
  if (-not [string]::IsNullOrEmpty($probeOutputContent)) {
    $probeOutput = $probeOutputContent.Trim()
  }
}
$probeError = ''
if (Test-Path $probeStderr) {
  $probeErrorContent = Get-Content $probeStderr -Raw
  if (-not [string]::IsNullOrEmpty($probeErrorContent)) {
    $probeError = $probeErrorContent.Trim()
  }
}
if ($probe.ExitCode -ne 0) {
  throw "native Codex node-pty probe failed: $probeError"
}
Write-Host $probeOutput

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_PATH)) {
  $nativeCodex.Directory.FullName |
    Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
}
