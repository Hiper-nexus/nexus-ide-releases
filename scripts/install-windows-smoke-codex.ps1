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
@'
const nodePty = require('@lydell/node-pty');
const expected = 'codex-cli 0.145.0';
const executable = process.env.NEXUS_SMOKE_CODEX_EXE;
let output = '';
let settled = false;
const terminal = nodePty.spawn(executable, ['--version'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { terminal.kill(); } catch {}
  console.error('native Codex node-pty probe timed out');
  process.exitCode = 1;
}, 15_000);
terminal.onData((data) => {
  if (output.length < 4096) output += data;
});
terminal.onExit(({ exitCode, signal }) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const normalized = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  if (exitCode !== 0 || signal || normalized !== expected) {
    console.error(JSON.stringify({ exitCode, signal, output: normalized }));
    process.exitCode = 1;
    return;
  }
  console.log(`[windows-smoke] native Codex node-pty proof: ${normalized}`);
});
'@ | node
if ($LASTEXITCODE -ne 0) { throw 'native Codex node-pty probe failed' }

$nativeCodex.Directory.FullName |
  Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
