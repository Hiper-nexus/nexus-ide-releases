# BridgeSpace Terminal - PowerShell Integration Loader
$global:BRIDGESPACE_SHELL_INTEGRATION = 1
$global:__bs_command_running = $false
$global:__bs_escape = [char]27

function global:__bs_emit([string]$payload) {
  Write-Host -NoNewline ("{0}]{1}{0}\" -f $global:__bs_escape, $payload)
}

function global:__bs_emit_cwd() {
  try {
    __bs_emit ("9;9;{0}" -f (Get-Location).Path)
  } catch {
    # noop
  }
}

if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
  try {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
      $global:__bs_command_running = $true
      __bs_emit '133;B'
      __bs_emit '133;C'
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  } catch {
    # noop
  }
}

function global:prompt {
  $exitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }
  if ($global:__bs_command_running) {
    __bs_emit ("133;D;{0}" -f $exitCode)
    $global:__bs_command_running = $false
  }
  __bs_emit_cwd
  __bs_emit '133;A'
  "PS $(Get-Location)> "
}

__bs_emit_cwd
__bs_emit '133;A'
