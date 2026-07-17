param(
  [string]$RuntimeRoot = "",
  [string]$WorkRoot = "",
  [ValidateRange(1024, 65520)]
  [int]$ServicePort = 6873,
  [ValidateRange(1024, 65520)]
  [int]$TriggerPort = 6881,
  [ValidateRange(1024, 65535)]
  [int]$ClientPort = 6884,
  [ValidateRange(10, 120)]
  [int]$StartupTimeoutSec = 45
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    $RuntimeRoot = $PSScriptRoot
  } else {
    $RuntimeRoot = $PSScriptRoot
  }
}
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$SourceMode = -not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "manifest.json") -PathType Leaf)
$RepoRoot = if ($SourceMode) {
  (Resolve-Path -LiteralPath (Join-Path $RuntimeRoot "..")).Path
} else {
  $RuntimeRoot
}
$ManifestPath = if ($SourceMode) {
  Join-Path $RepoRoot "target\packages\steel-inspection-runtime\manifest.json"
} else {
  Join-Path $RuntimeRoot "manifest.json"
}
$SmokeScript = Join-Path $RuntimeRoot "test-integrated-management-smoke.ps1"
$StabilityScript = Join-Path $RuntimeRoot "test-production-stability.ps1"
foreach ($RequiredPath in @($ManifestPath, $SmokeScript, $StabilityScript)) {
  if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
    throw "WorkRoot stability contract prerequisite is missing: $RequiredPath"
  }
}

if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
  $Base = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\production-stability-workroot-contract"
  } else {
    Join-Path ([System.IO.Path]::GetTempPath()) "steel-production-stability-workroot-contract"
  }
  $WorkRoot = Join-Path $Base ([guid]::NewGuid().ToString("N"))
}
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

$TriggerTcpPort = $TriggerPort + 1
$TriggerUdpPort = $TriggerPort + 2
$Ports = @($ServicePort, $TriggerPort, $TriggerTcpPort, $TriggerUdpPort, $ClientPort)
if (@($Ports | Sort-Object -Unique).Count -ne $Ports.Count -or
    @($Ports | Where-Object { $_ -gt 65535 }).Count -gt 0) {
  throw "Contract ports must be unique and within 1..65535."
}

function Get-TcpListenerOwners {
  param([int[]]$Port)
  try {
    return @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $Port -contains [int]$_.LocalPort } |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @()
  }
}

function Get-UdpListenerOwners {
  param([int[]]$Port)
  try {
    return @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
      Where-Object { $Port -contains [int]$_.LocalPort } |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @()
  }
}

function Stop-ContractProcesses {
  param([int[]]$ReceiptProcessIds)

  $ListenerOwners = @(
    Get-TcpListenerOwners -Port $Ports
    Get-UdpListenerOwners -Port $Ports
  )
  $ParentIds = @()
  if ($ListenerOwners.Count -gt 0) {
    $ParentIds = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $ListenerOwners -contains [int]$_.ProcessId } |
      Select-Object -ExpandProperty ParentProcessId -Unique)
  }
  foreach ($ProcessId in @($ListenerOwners + $ParentIds + $ReceiptProcessIds |
      Where-Object { $_ -gt 4 -and $_ -ne $PID } |
      Sort-Object -Unique)) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$ExistingOwners = @(
  Get-TcpListenerOwners -Port $Ports
  Get-UdpListenerOwners -Port $Ports
)
if ($ExistingOwners.Count -gt 0) {
  throw "WorkRoot stability contract ports are already in use by PID(s): $($ExistingOwners -join ', ')"
}

$MutexName = "Local\SteelProductionStabilityWorkRootContract_{0}_{1}_{2}" -f $ServicePort, $TriggerPort, $ClientPort
$Mutex = [System.Threading.Mutex]::new($false, $MutexName)
$MutexAcquired = $false
$ReceiptProcessIds = @()
$Launcher = $null
try {
  try {
    $MutexAcquired = $Mutex.WaitOne([TimeSpan]::FromSeconds(120))
  } catch [System.Threading.AbandonedMutexException] {
    $MutexAcquired = $true
  }
  if (-not $MutexAcquired) {
    throw "Timed out waiting for contract mutex: $MutexName"
  }

  $SmokeRoot = Join-Path $WorkRoot "smoke"
  $LaunchOut = Join-Path $WorkRoot "smoke-launch.out.log"
  $LaunchErr = Join-Path $WorkRoot "smoke-launch.err.log"
  $SmokeArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $SmokeScript,
    "-ServicePort", [string]$ServicePort,
    "-TriggerPort", [string]$TriggerPort,
    "-ClientPort", [string]$ClientPort,
    "-SkipClient",
    "-KeepRunning",
    "-WorkRoot", $SmokeRoot
  )
  $Launcher = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $SmokeArguments `
    -WorkingDirectory $WorkRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LaunchOut `
    -RedirectStandardError $LaunchErr `
    -PassThru
  if (-not $Launcher.WaitForExit($StartupTimeoutSec * 1000)) {
    throw "KeepRunning smoke launcher did not return within ${StartupTimeoutSec}s."
  }

  $SmokeReport = Get-ChildItem -LiteralPath (Join-Path $SmokeRoot "reports") `
    -File -Filter "integrated-smoke-*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime |
    Select-Object -Last 1
  if (-not $SmokeReport) {
    $ErrorText = if (Test-Path -LiteralPath $LaunchErr -PathType Leaf) {
      Get-Content -LiteralPath $LaunchErr -Raw
    } else { "" }
    throw "KeepRunning smoke report was not written. $ErrorText"
  }
  $Smoke = Get-Content -LiteralPath $SmokeReport.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$Smoke.code -ne 0 -or $Smoke.keptRunning -ne $true) {
    throw "KeepRunning smoke did not pass."
  }
  $ReceiptProcessIds = @($Smoke.startedProcesses | ForEach-Object { [int]$_.id })
  if ($ReceiptProcessIds.Count -ne 2 -or
      @($Smoke.startedProcesses | Where-Object { $_.hasExited -eq $true }).Count -gt 0) {
    throw "KeepRunning smoke must return two live wrapper-process receipts."
  }
  $ExpectedListeners = @($ServicePort, $TriggerPort, $TriggerTcpPort, $TriggerUdpPort)
  $ActualListeners = @($Smoke.startedListeners | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  if (($ActualListeners -join ",") -cne (($ExpectedListeners | Sort-Object) -join ",")) {
    throw "KeepRunning listener receipt mismatch. expected=$($ExpectedListeners -join ',') actual=$($ActualListeners -join ',')"
  }
  $ServiceWorkRoot = [System.IO.Path]::GetFullPath([string]$Smoke.service.workRoot)
  $ContractPrefix = $WorkRoot.TrimEnd('\') + '\'
  if (-not $ServiceWorkRoot.StartsWith($ContractPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke service WorkRoot escaped the contract root: $ServiceWorkRoot"
  }

  $StabilityReportRoot = Join-Path $WorkRoot "reports"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StabilityScript `
    -ServiceOrigin "http://127.0.0.1:$ServicePort" `
    -TriggerOrigin "http://127.0.0.1:$TriggerPort" `
    -SkipClient `
    -SkipTrigger `
    -DurationSec 0 `
    -MaxCycles 1 `
    -IntervalSec 0 `
    -TimeoutMs 3000 `
    -ReleaseManifestPath $ManifestPath `
    -ReportDir $StabilityReportRoot `
    -WorkRoot $ServiceWorkRoot | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Production stability WorkRoot contract run failed with exit $LASTEXITCODE."
  }

  $StabilityReport = Get-ChildItem -LiteralPath $StabilityReportRoot `
    -File -Filter "production-stability-*.json" |
    Sort-Object LastWriteTime |
    Select-Object -Last 1
  $Stability = Get-Content -LiteralPath $StabilityReport.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$Stability.code -ne 0 -or
      [int]$Stability.totals.cycles -ne 1 -or
      [int]$Stability.totals.okCycles -ne 1 -or
      $Stability.finalConvergence.converged -ne $true) {
    throw "Production stability WorkRoot contract report did not pass."
  }
  $SummaryPath = [System.IO.Path]::GetFullPath([string]$Stability.cycles[0].summary.path)
  $ServicePrefix = $ServiceWorkRoot.TrimEnd('\') + '\'
  if (-not $SummaryPath.StartsWith($ServicePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) {
    throw "Resolved production summary did not stay inside the service WorkRoot: $SummaryPath"
  }
  if ([string]$Stability.cycles[0].capture.summaryOutput -notmatch "^simulated[\\/]+production[\\/]") {
    throw "Contract did not exercise a relative provider.summaryOutput path."
  }

  [ordered]@{
    schema = "steel.production-stability-workroot.contract-test.v1"
    code = 0
    runtimeRoot = $RuntimeRoot
    workRoot = $WorkRoot
    smokeReport = $SmokeReport.FullName
    stabilityReport = $StabilityReport.FullName
    summaryPath = $SummaryPath
    checks = @(
      "keep-running-launcher-returned",
      "process-receipt-complete",
      "listener-receipt-complete",
      "relative-summary-output-resolved",
      "summary-contained-in-workroot",
      "production-cycle-converged"
    )
  } | ConvertTo-Json -Depth 6
} finally {
  Stop-ContractProcesses -ReceiptProcessIds $ReceiptProcessIds
  Start-Sleep -Milliseconds 500
  $RemainingOwners = @(
    Get-TcpListenerOwners -Port $Ports
    Get-UdpListenerOwners -Port $Ports
  )
  if ($RemainingOwners.Count -gt 0) {
    Write-Error "Contract listener cleanup failed for PID(s): $($RemainingOwners -join ', ')"
  }
  if ($MutexAcquired) {
    try { $Mutex.ReleaseMutex() } catch {}
  }
  $Mutex.Dispose()
}
