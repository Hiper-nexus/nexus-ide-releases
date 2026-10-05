# Runs only on the protected native Windows worker, after Forge make.
# Windows releases are not Authenticode-signed since 05/10/2026 (the paid
# eSigner service was removed; the Microsoft Store signs the Store build). The
# receipt records the SHA-256 of every executable instead of a signature.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-OneFile([string]$Root, [string]$Filter) {
  $files = @(Get-ChildItem $Root -Recurse -File -Filter $Filter)
  if ($files.Count -ne 1) { throw "Expected one $Filter; found $($files.Count)" }
  return $files[0]
}

function Get-ExecutableHash([string]$Filename) {
  return @{ sha256 = (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash.ToLowerInvariant() }
}

if ($env:OS -ne 'Windows_NT' -or (node -p 'process.arch') -ne 'x64') { throw 'Native Windows x64 required' }
$version = node -p "require('./package.json').version"
if ($version -ne $env:RELEASE_VERSION -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release version mismatch' }
if ((git rev-parse HEAD) -ne $env:GITHUB_SHA -or $env:GITHUB_RUN_ID -notmatch '^\d+$') { throw 'Workflow identity mismatch' }
$setup = Get-OneFile 'out/make' '*Setup.exe'
$package = Get-OneFile 'out/make' '*-full.nupkg'
$releases = Get-OneFile 'out/make' 'RELEASES'
if ($package.Name -cne "nexus_ide-$version-full.nupkg") { throw 'NUPKG version mismatch' }
$releaseEntry = (Get-Content $releases.FullName -Raw).Trim()
$packageHash = (Get-FileHash $package.FullName -Algorithm SHA1).Hash.ToLowerInvariant()
if ($releaseEntry -cne "$packageHash $($package.Name) $($package.Length)" -and
    $releaseEntry -cne "$($packageHash.ToUpperInvariant()) $($package.Name) $($package.Length)") { throw 'RELEASES must contain only the original full package entry' }

$temporary = Join-Path $env:RUNNER_TEMP ('nexus-candidate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $archive = Join-Path $temporary 'full.zip'
  $extracted = Join-Path $temporary 'full'
  Copy-Item $package.FullName $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $extracted
  $app = Get-OneFile $extracted 'nexus-ide.exe'
  # Squirrel.exe in the NUPKG becomes installed Update.exe.
  $updater = Get-OneFile $extracted 'Squirrel.exe'
  $stub = Get-OneFile $extracted 'nexus-ide_ExecutionStub.exe'
  $executables = @{
    setup = Get-ExecutableHash $setup.FullName
    app = Get-ExecutableHash $app.FullName
    updater = Get-ExecutableHash $updater.FullName
    stub = Get-ExecutableHash $stub.FullName
  }
  node scripts/smoke-packaged-app.mjs --app $app.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Full-package native smoke failed' }

  $assets = Join-Path (Get-Location) 'windows-release-assets'
  if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
  New-Item -ItemType Directory -Path $assets | Out-Null
  $setupName = "NexusIDE-$version-win32-x64-Setup.exe"
  Copy-Item $setup.FullName (Join-Path $assets $setupName)
  Copy-Item $package.FullName (Join-Path $assets $package.Name)
  Copy-Item $releases.FullName (Join-Path $assets 'RELEASES')
  $inventory = @(@($setupName, $package.Name, 'RELEASES') | ForEach-Object {
    $file = Get-Item (Join-Path $assets $_)
    @{ name = $file.Name; size = $file.Length; sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  $receipt = @{
    schemaVersion = 2
    version = $version
    commitSha = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID
    platform = 'win32'
    arch = 'x64'
    signing = 'none'
    smoke = @{ status = 'pass'; kind = 'nupkg-native'; installedUpgradeVerified = $false }
    executables = $executables
    assets = $inventory
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $assets 'windows-release-receipt.json') -Encoding utf8NoBOM
} finally {
  Remove-Item $temporary -Recurse -Force
}
