param(
  [switch]$IncludeNode
)

$ErrorActionPreference = "Stop"

$Patterns = @("*steel-inspection-service*", "*steel_capture_service*", "*steel_capture_qt_terminal*")
if ($IncludeNode) {
  $Patterns += @("*node*", "*vite*")
}

$Processes = Get-Process | Where-Object {
  $Process = $_
  $Patterns | Where-Object {
    $Process.ProcessName -like $_ -or ($Process.Path -and $Process.Path -like $_)
  }
}

if (-not $Processes) {
  Write-Host "No steel inspection runtime processes found."
  return
}

$Processes | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
$Processes | Stop-Process -Force
Write-Host "Stopped $($Processes.Count) runtime process(es)."
