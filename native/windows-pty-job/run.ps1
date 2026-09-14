param(
  [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'nexus-windows-job-spike')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 PowerShell required' }
$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installation)) { throw 'MSVC x64 installation not found' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$env:NEXUS_JOB_SPIKE_VS = $installation.Trim()
$env:NEXUS_JOB_SPIKE_SOURCE = $PSScriptRoot
$env:NEXUS_JOB_SPIKE_OUTPUT = $output
$executable = Join-Path $output 'job-spike.exe'
if (Test-Path $executable) { Remove-Item $executable -Force }
$compile = Join-Path $output 'compile.cmd'
@'
@echo off
call "%NEXUS_JOB_SPIKE_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
echo MSVC_TOOLSET=%VCToolsVersion%
echo WINDOWS_SDK=%WindowsSDKVersion%
echo HOST_ARCH=%VSCMD_ARG_HOST_ARCH%
echo TARGET_ARCH=%VSCMD_ARG_TGT_ARCH%
cl /nologo /Bv /EHsc /std:c++20 /W4 /WX /permissive- /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fe:"%NEXUS_JOB_SPIKE_OUTPUT%\job-spike.exe" /Fo:"%NEXUS_JOB_SPIKE_OUTPUT%\job-spike.obj" "%NEXUS_JOB_SPIKE_SOURCE%\job-spike.cc" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT advapi32.lib bcrypt.lib
exit /b %errorlevel%
'@ | Set-Content -LiteralPath $compile -Encoding ascii
& cmd.exe /d /c $compile 2>&1 | Tee-Object -FilePath (Join-Path $output 'build.log')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $executable)) { throw 'Native spike compilation failed' }
@{
  executableSha256 = (Get-FileHash $executable -Algorithm SHA256).Hash.ToLowerInvariant()
  osVersion = [Environment]::OSVersion.VersionString
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  sourceCommit = $env:GITHUB_SHA
  runId = $env:GITHUB_RUN_ID
  conptyProvider = 'Windows SDK CreatePseudoConsole (not production vendored DLL)'
} | ConvertTo-Json | Set-Content (Join-Path $output 'build-metadata.json') -Encoding utf8NoBOM
$stdout = Join-Path $output 'test-stdout.jsonl'
$stderr = Join-Path $output 'test-stderr.log'
$process = Start-Process -FilePath $executable -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
# Retain the exact created process's native handle before any wait/cleanup.
$ownedProcessHandle = $process.SafeHandle
try {
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw 'Timed-out native fixture did not exit' }
    throw 'Native fixture exceeded 120-second watchdog; no lifecycle proof accepted'
  }
  $exitCode = $process.ExitCode
  Get-Content $stdout
  if (Test-Path $stderr) { Get-Content $stderr }
  if ($exitCode -ne 0) { throw "Native fixture failed with exit $exitCode" }
  $records = @(Get-Content $stdout | ForEach-Object { $_ | ConvertFrom-Json })
  $summary = $records[-1]
  if ($summary.summary -ne 'pass' -or $summary.tests -ne 6) { throw 'Native fixture did not report all six tests passing' }
} finally {
  $process.Dispose()
}
