# Runs on the native Windows worker or the operator's Windows PC, after Forge make.
# The paid eSigner service was removed on 05/10/2026. A build signed with
# NEXUS_WINDOWS_YUBIKEY_SIGNING=1 carries Authenticode from the YubiKey
# certificate pinned in build/windows-signing-identity.json (19/10/2026); an
# unsigned build records `signing = 'none'`. Every executable gets its SHA-256
# either way, and a mix of signed and unsigned executables is refused.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$identity = Get-Content -LiteralPath 'build/windows-signing-identity.json' -Raw | ConvertFrom-Json
if ($identity.schemaVersion -ne 1 -or $identity.signing -cne 'yubikey' -or $identity.spkiSha256 -cnotmatch '^[a-f0-9]{64}$') {
  throw 'build/windows-signing-identity.json is malformed'
}

function Get-OneFile([string]$Root, [string]$Filter) {
  $files = @(Get-ChildItem $Root -Recurse -File -Filter $Filter)
  if ($files.Count -ne 1) { throw "Expected one $Filter; found $($files.Count)" }
  return $files[0]
}

function Get-ExecutableRecord([string]$Filename) {
  $record = [ordered]@{ sha256 = (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash.ToLowerInvariant() }
  $signature = Get-AuthenticodeSignature -LiteralPath $Filename
  if ($signature.Status -eq 'NotSigned') { return $record }
  $signer = $signature.SignerCertificate
  if ($signature.Status -ne 'Valid' -or $null -eq $signer -or $null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode signature or timestamp invalid: $Filename"
  }
  # The SPKI pin binds the signature to the YubiKey slot 9a key itself, so a
  # certificate over any other key is refused even under the pinned thumbprint.
  $spki = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData(
    $signer.PublicKey.ExportSubjectPublicKeyInfo())).ToLowerInvariant()
  if ($signer.Thumbprint -cne $identity.certificateSha1 -or $spki -cne $identity.spkiSha256 -or
      $signer.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $identity.publisherCommonName) {
    throw "Unexpected signer (not the pinned YubiKey certificate): $Filename"
  }
  $record.signature = [ordered]@{
    thumbprint = $signer.Thumbprint
    spkiSha256 = $spki
    timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
  }
  return $record
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
  $executables = [ordered]@{
    setup = Get-ExecutableRecord $setup.FullName
    app = Get-ExecutableRecord $app.FullName
    updater = Get-ExecutableRecord $updater.FullName
    stub = Get-ExecutableRecord $stub.FullName
  }
  $signedCount = @($executables.Values | Where-Object { $_.Contains('signature') }).Count
  if ($signedCount -eq 0) { $signing = 'none' }
  elseif ($signedCount -eq $executables.Count) { $signing = $identity.signing }
  else { throw "Only $signedCount of $($executables.Count) executables are signed: sign all of them with the YubiKey or none" }
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
    signing = $signing
    smoke = @{ status = 'pass'; kind = 'nupkg-native'; installedUpgradeVerified = $false }
    executables = $executables
    assets = $inventory
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $assets 'windows-release-receipt.json') -Encoding utf8NoBOM
} finally {
  Remove-Item $temporary -Recurse -Force
}
