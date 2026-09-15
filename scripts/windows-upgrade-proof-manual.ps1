param(
  [string]$FromVersion = '0.76.32',
  [Parameter(Mandatory = $true)]
  [string]$ToVersion,
  [Parameter(Mandatory = $true)]
  [string]$CandidateDir,
  [string]$OutFile,
  [string]$BaselineSetup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PublisherSubject = 'HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA'
$PackageId = 'nexus_ide'
$ProductName = 'NexusIDE'
$ExecutableName = 'nexus-ide.exe'
$SetupName = "NexusIDE-$ToVersion-win32-x64-Setup.exe"
$PackageName = "nexus_ide-$ToVersion-full.nupkg"
$InstallRoot = Join-Path $env:LOCALAPPDATA $PackageId
$UserDataDir = Join-Path $env:APPDATA $ProductName
$MarkerName = 'manual-upgrade-proof-marker.json'
$MarkerPath = Join-Path $UserDataDir $MarkerName
$StartedAt = (Get-Date).ToUniversalTime().ToString('o')
$Checks = [ordered]@{
  signedBaselineInstalled = $false
  squirrelUpgradeApplied = $false
  targetRestarted = $false
  userDataPreserved = $false
}
$script:AssetSha256 = [ordered]@{}
$script:ResolvedOutFile = ''
$Log = New-Object System.Collections.Generic.List[string]

function Add-Log([string]$Message) {
  $Log.Add("$((Get-Date).ToUniversalTime().ToString('o')) $Message")
}

function Assert-StableVersion([string]$Name, [string]$Value) {
  if ($Value -notmatch '^\d+\.\d+\.\d+$') {
    throw "$Name deve estar no formato N.N.N: $Value"
  }
}

function Resolve-AbsolutePath([string]$PathValue) {
  $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Assert-FileExists([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "$Label não encontrado: $PathValue"
  }
}

function Assert-DirectoryExists([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label não encontrado: $PathValue"
  }
}

function Get-LowerSha256([string]$PathValue) {
  (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-TrustedSignature([string]$PathValue, [string]$Label) {
  Add-Log "Verificando assinatura Authenticode: $Label"
  $signature = Get-AuthenticodeSignature -LiteralPath $PathValue
  $subject = ''
  if ($null -ne $signature.SignerCertificate) {
    $subject = [string]$signature.SignerCertificate.Subject
  }
  if ($signature.Status -ne 'Valid' -or $subject -notlike "*$PublisherSubject*") {
    throw "Assinatura inválida em $Label ($PathValue): Status=$($signature.Status); Subject=$subject"
  }
}

function Wait-ForPath([string]$PathValue, [string]$Label, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $PathValue) {
      Add-Log "$Label encontrado: $PathValue"
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "Tempo esgotado aguardando $Label: $PathValue"
}

function Get-ProcessByExecutablePath([string]$PathValue) {
  $normalized = [System.IO.Path]::GetFullPath($PathValue)
  @(Get-CimInstance Win32_Process -Filter "Name='$ExecutableName'" |
    Where-Object {
      $_.ExecutablePath -and
      ([System.IO.Path]::GetFullPath($_.ExecutablePath)).Equals(
        $normalized,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    })
}

function Start-AppAndWait([string]$ExePath, [string]$Label) {
  Add-Log "Abrindo $Label: $ExePath"
  Start-Process -FilePath $ExePath | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $processes = @(Get-ProcessByExecutablePath $ExePath)
    if ($processes.Count -gt 0) {
      Add-Log "$Label rodando a partir de $ExePath"
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "$Label não iniciou a partir de $ExePath"
}

function Stop-AppByPath([string]$ExePath) {
  $processes = @(Get-ProcessByExecutablePath $ExePath)
  foreach ($processInfo in $processes) {
    Add-Log "Fechando processo $($processInfo.ProcessId): $ExePath"
    Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-ProcessAndWait([string]$FilePath, [string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds) {
  Add-Log "$Label"
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Tempo esgotado: $Label"
  }
  if ($process.ExitCode -ne 0) {
    throw "$Label falhou com exit code $($process.ExitCode)"
  }
}

function Complete-Proof([string]$Status) {
  $finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $machine = [ordered]@{
    hostname = $env:COMPUTERNAME
    osVersion = [System.Environment]::OSVersion.VersionString
  }
  $proof = [ordered]@{
    schemaVersion = 1
    kind = 'manual-operator-upgrade-proof'
    status = $Status
    fromVersion = $FromVersion
    toVersion = $ToVersion
    machine = $machine
    startedAt = $StartedAt
    finishedAt = $finishedAt
    assetSha256 = $script:AssetSha256
    checks = $Checks
    log = @($Log)
  }
  $outParent = Split-Path -Parent $script:ResolvedOutFile
  if (-not [string]::IsNullOrWhiteSpace($outParent)) {
    New-Item -ItemType Directory -Path $outParent -Force | Out-Null
  }
  Add-Log "Evidência gravada: $script:ResolvedOutFile"
  $proof['log'] = @($Log)
  $proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:ResolvedOutFile -Encoding UTF8
}

try {
  Assert-StableVersion 'FromVersion' $FromVersion
  Assert-StableVersion 'ToVersion' $ToVersion
  if ($FromVersion -eq $ToVersion) {
    throw 'FromVersion e ToVersion não podem ser iguais'
  }
  if ($env:OS -ne 'Windows_NT') {
    throw 'Este script deve ser executado em Windows'
  }

  $CandidateDir = Resolve-AbsolutePath $CandidateDir
  if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $OutFile = ".\upgrade-proof-$ToVersion.json"
  }
  $script:ResolvedOutFile = Resolve-AbsolutePath $OutFile
  Assert-DirectoryExists $CandidateDir 'CandidateDir'

  $candidateSetup = Join-Path $CandidateDir $SetupName
  $candidatePackage = Join-Path $CandidateDir $PackageName
  $candidateReleases = Join-Path $CandidateDir 'RELEASES'
  Assert-FileExists $candidateSetup 'Setup candidato'
  Assert-FileExists $candidatePackage 'NUPKG candidato'
  Assert-FileExists $candidateReleases 'RELEASES candidato'

  $script:AssetSha256 = [ordered]@{
    $SetupName = Get-LowerSha256 $candidateSetup
    $PackageName = Get-LowerSha256 $candidatePackage
    RELEASES = Get-LowerSha256 $candidateReleases
  }

  if ([string]::IsNullOrWhiteSpace($BaselineSetup)) {
    $downloadDir = Join-Path $env:TEMP "nexus-upgrade-proof-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $downloadDir | Out-Null
    $BaselineSetup = Join-Path $downloadDir "NexusIDE-$FromVersion-win32-x64-Setup.exe"
    $baselineUrl = "https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v$FromVersion/NexusIDE-$FromVersion-win32-x64-Setup.exe"
    Add-Log "Baixando Setup baseline: $baselineUrl"
    Invoke-WebRequest -Uri $baselineUrl -OutFile $BaselineSetup
  } else {
    $BaselineSetup = Resolve-AbsolutePath $BaselineSetup
  }
  Assert-FileExists $BaselineSetup 'Setup baseline'

  Assert-TrustedSignature $BaselineSetup 'Setup baseline'
  Assert-TrustedSignature $candidateSetup 'Setup candidato'
  Assert-TrustedSignature $candidatePackage 'NUPKG candidato'

  # Squirrel.Windows aceita --silent e -s; usamos --silent por legibilidade.
  Invoke-ProcessAndWait $BaselineSetup @('--silent') 'Instalando baseline com Squirrel --silent' 180
  $baselineExe = Join-Path (Join-Path $InstallRoot "app-$FromVersion") $ExecutableName
  Wait-ForPath $baselineExe 'Executável baseline instalado' 180
  $Checks.signedBaselineInstalled = $true

  Start-AppAndWait $baselineExe 'baseline'
  Start-Sleep -Seconds 20
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  $marker = [ordered]@{
    kind = 'manual-upgrade-proof-marker'
    fromVersion = $FromVersion
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $MarkerPath -Encoding UTF8
  Add-Log "Marcador gravado em userData: $MarkerPath"
  Stop-AppByPath $baselineExe

  $updateExe = Join-Path $InstallRoot 'Update.exe'
  Assert-FileExists $updateExe 'Update.exe instalado'
  Invoke-ProcessAndWait $updateExe @("--update=$CandidateDir") 'Aplicando update Squirrel a partir da pasta candidata' 300
  $targetExe = Join-Path (Join-Path $InstallRoot "app-$ToVersion") $ExecutableName
  Wait-ForPath $targetExe 'Executável alvo instalado' 240
  $Checks.squirrelUpgradeApplied = $true

  Start-AppAndWait $targetExe 'versão alvo'
  $Checks.targetRestarted = $true
  if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
    throw "Marcador de userData não foi preservado: $MarkerPath"
  }
  $Checks.userDataPreserved = $true
  Stop-AppByPath $targetExe

  Add-Log 'Prova manual N->N+1 concluída com sucesso'
  Complete-Proof 'pass'
  Write-Host "PASS: evidência gravada em $script:ResolvedOutFile"
} catch {
  Add-Log "FALHA: $($_.Exception.Message)"
  try {
    if (-not $script:AssetSha256) { $script:AssetSha256 = [ordered]@{} }
    if (-not $script:ResolvedOutFile) {
      if ([string]::IsNullOrWhiteSpace($OutFile)) { $OutFile = ".\upgrade-proof-$ToVersion.json" }
      $script:ResolvedOutFile = Resolve-AbsolutePath $OutFile
    }
    Complete-Proof 'fail'
  } catch {
    Write-Warning "Também falhou ao gravar a evidência: $($_.Exception.Message)"
  }
  throw
}
