param(
  [switch]$IncludeNode,
  [int[]]$Ports = @(4317, 4873, 4874, 4875, 4876, 4881, 1432)
)

$ErrorActionPreference = "Stop"

function Get-ListenerProcessIds {
  param([int]$Port)

  $Ids = @()
  try {
    $Ids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $Ids = @()
  }

  if (-not $Ids -or $Ids.Count -eq 0) {
    $Lines = netstat -ano | Select-String ":$Port\s"
    foreach ($Line in $Lines) {
      if ([string]$Line -match "LISTENING\s+(\d+)") {
        $Ids += [int]$Matches[1]
      }
    }
  }

  return @($Ids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

$Patterns = @(
  "*steel-inspection-service*",
  "*steel-trigger-gateway*",
  "*steel_trigger_gateway*",
  "*steel_capture_service*",
  "*steel-capture-service*",
  "*steel-image-service*",
  "*steel-image-worker*",
  "*steel-defect-worker*",
  "*steel-inspection-tray*"
)
if ($IncludeNode) {
  $Patterns += @("*node*", "*vite*")
}

$Processes = Get-Process | Where-Object {
  $Process = $_
  $Patterns | Where-Object {
    $Process.ProcessName -like $_ -or ($Process.Path -and $Process.Path -like $_)
  }
}

$PortProcesses = @()
foreach ($Port in $Ports) {
  foreach ($ProcessId in (Get-ListenerProcessIds -Port $Port)) {
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($Process) {
      $PortProcesses += $Process
    }
  }
}

$Processes = @(
  @($Processes) + @($PortProcesses) |
    Where-Object { $_ -and $_.Id -gt 4 -and $_.Id -ne $PID } |
    Sort-Object Id -Unique
)

if (-not $Processes -or $Processes.Count -eq 0) {
  Write-Host "No steel inspection runtime processes found."
  return
}

$Processes | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
$Processes | Stop-Process -Force
Write-Host "Stopped $($Processes.Count) runtime process(es)."
