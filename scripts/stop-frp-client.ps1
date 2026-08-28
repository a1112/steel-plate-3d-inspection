param(
  [string]$RunRoot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($RunRoot)) {
  $RunRoot = Join-Path $RepoRoot "target\run\frp-client"
}
$RunRoot = [System.IO.Path]::GetFullPath($RunRoot)
$StatePath = Join-Path $RunRoot "frpc-state.json"
if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  Write-Host "FRP client is not tracked as running."
  return
}

$State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$PidValue = [int]$State.pid
$ExpectedExecutable = [System.IO.Path]::GetFullPath([string]$State.executable)
$Process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
if (-not $Process) {
  Remove-Item -LiteralPath $StatePath -Force
  Write-Host "Removed stale FRP client state for PID $PidValue."
  return
}
if (-not $Process.Path.Equals($ExpectedExecutable, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetFileName($Process.Path) -ne "frpc.exe") {
  throw "Tracked PID $PidValue does not identify the expected frpc executable; it was not stopped."
}

Stop-Process -Id $PidValue -Force
Remove-Item -LiteralPath $StatePath -Force
Write-Host "Stopped FRP client PID $PidValue."
