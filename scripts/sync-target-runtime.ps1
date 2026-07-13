param(
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "debug",
  [switch]$IncludeQt
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeRoot = Join-Path $RepoRoot "target\runtime"
$CaptureOut = Join-Path $RuntimeRoot "capture-headless"
$CaptureQtOut = Join-Path $RuntimeRoot "capture-qt"
$ServiceOut = Join-Path $RuntimeRoot "service"
$TriggerOut = Join-Path $RuntimeRoot "trigger"
$ClientOut = Join-Path $RuntimeRoot "client"
$ConfigOut = Join-Path $RuntimeRoot "config"
$LogsOut = Join-Path $RuntimeRoot "logs"
$ScriptsOut = Join-Path $RuntimeRoot "scripts"
$DocsOut = Join-Path $RuntimeRoot "docs"
$AlgorithmCoreOut = Join-Path $RuntimeRoot "algorithm-core"

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source -PathType Leaf)) {
    throw "Missing required file: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Write-RuntimeFile {
  param(
    [string]$RelativePath,
    [string]$Content
  )
  $Destination = Join-Path $RuntimeRoot $RelativePath
  $DestinationDir = Split-Path -Parent $Destination
  if ($DestinationDir -and -not (Test-Path $DestinationDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  }
  Set-Content -Path $Destination -Value $Content -Encoding UTF8
}

$MigrationArchitectureTest = Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1"
$MigrationArchitectureReportText = (& $MigrationArchitectureTest -RepoRoot ([string]$RepoRoot) | Out-String)
$MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
if ($MigrationArchitectureReport.code -ne 0) {
  throw "Architecture migration contract failed before runtime synchronization."
}
$MigrationArchitecture = $MigrationArchitectureReport.contract

if (Test-Path $RuntimeRoot) {
  $ResolvedRuntime = Resolve-Path $RuntimeRoot
  $ResolvedTarget = Resolve-Path (Join-Path $RepoRoot "target")
  if (-not $ResolvedRuntime.Path.StartsWith($ResolvedTarget.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove runtime directory outside target: $ResolvedRuntime"
  }
  Remove-Item -LiteralPath $ResolvedRuntime.Path -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CaptureOut, $ServiceOut, $TriggerOut, $ClientOut, $ConfigOut, $LogsOut, $ScriptsOut, $DocsOut, $AlgorithmCoreOut | Out-Null

$CaptureBuild = Join-Path $RepoRoot "target\capture\$Configuration"
Copy-RequiredFile (Join-Path $CaptureBuild "steel_capture_service.exe") $CaptureOut
Copy-RequiredFile (Join-Path $CaptureBuild "nvt_lvm_sdk.dll") $CaptureOut

if ($IncludeQt) {
  $CaptureQtBuild = Join-Path $RepoRoot "target\capture-qt\$Configuration"
  if (-not (Test-Path (Join-Path $CaptureQtBuild "steel_capture_qt_terminal.exe") -PathType Leaf)) {
    throw "Missing Qt executable under $CaptureQtBuild. Run scripts/build-capture-qt.ps1 first."
  }
  New-Item -ItemType Directory -Force -Path $CaptureQtOut | Out-Null
  Get-ChildItem -LiteralPath $CaptureQtBuild -Force | Copy-Item -Destination $CaptureQtOut -Recurse -Force
}

$ServiceBuild = Join-Path $RepoRoot "target\cargo\$ServiceProfile"
Copy-RequiredFile (Join-Path $ServiceBuild "steel-inspection-service.exe") $ServiceOut

$TriggerBuild = Join-Path $RepoRoot "target\trigger\$ServiceProfile"
Copy-RequiredFile (Join-Path $TriggerBuild "steel-trigger-gateway.exe") $TriggerOut

$AlgorithmCoreBuild = Join-Path $RepoRoot "target\algorithm-core\$Configuration"
Copy-RequiredFile (Join-Path $AlgorithmCoreBuild "steel_bar_surface_core.exe") $AlgorithmCoreOut

$ClientBuild = Join-Path $RepoRoot "target\client\frontend-dist"
if (-not (Test-Path $ClientBuild -PathType Container)) {
  throw "Missing client build directory: $ClientBuild. Run scripts/build-client.ps1 first."
}
Get-ChildItem -LiteralPath $ClientBuild -Force | Copy-Item -Destination $ClientOut -Recurse -Force

if (Test-Path (Join-Path $RepoRoot "config\env") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\env") -Destination $ConfigOut -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "config\capture") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\capture") -Destination $ConfigOut -Recurse -Force
}
Copy-RequiredFile (Join-Path $RepoRoot "scripts\run-client-static.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-acceptance-audit.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\bar_surface_reconstruct.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\fit_array_calibration_cross_section.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\independent-architecture.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\capture-api-contract.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\integrated-capture-management-acceptance.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\qt-to-tauri-migration.md") $DocsOut

Write-RuntimeFile "run-capture-headless.ps1" @'
param(
  [int]$Port = 4317,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-headless\steel_capture_service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing capture executable: $Exe"
}

$env:CAPTURE_STORAGE_ROOT = $StorageRoot
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null

Push-Location (Split-Path -Parent $Exe)
try {
  & $Exe --port $Port
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
'@

if ($IncludeQt) {
  Write-RuntimeFile "run-capture-qt.ps1" @'
param(
  [int]$Port = 4317,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-qt\steel_capture_qt_terminal.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing Qt capture executable: $Exe"
}

$env:PATH = "$(Split-Path -Parent $Exe);$env:PATH"
$env:CAPTURE_QT_API_AUTOSTART = "0"
$env:CAPTURE_SERVICE_PORT = [string]$Port
$env:CAPTURE_STORAGE_ROOT = $StorageRoot
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null

& $Exe
exit $LASTEXITCODE
'@
}

Write-RuntimeFile "run-service-headless.ps1" @'
param(
  [int]$Port = 4873,
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$TriggerOrigin = "http://127.0.0.1:4881"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "external-api"
$env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
$env:STEEL_SERVICE_CONFIG_DIR = Join-Path $Root "config\service"
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null

& $Exe
exit $LASTEXITCODE
'@

Write-RuntimeFile "run-service-simulated.ps1" @'
param(
  [int]$Port = 4873,
  [string]$ConfigRoot = "",
  [string]$TriggerOrigin = "http://127.0.0.1:4881"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $Root "config\service"
}

$env:INSPECTION_SERVICE_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "simulated"
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null
Remove-Item Env:\CAPTURE_SERVICE_ORIGIN -ErrorAction SilentlyContinue

& $Exe
exit $LASTEXITCODE
'@

Write-RuntimeFile "run-trigger-gateway.ps1" @'
param(
  [int]$Port = 4881,
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$Mode = "manual"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "trigger\steel-trigger-gateway.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing trigger gateway executable: $Exe"
}

$env:TRIGGER_GATEWAY_PORT = [string]$Port
$env:TRIGGER_GATEWAY_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
$env:TRIGGER_MODE = $Mode

& $Exe
exit $LASTEXITCODE
'@

Write-RuntimeFile "run-integrated-capture-management.ps1" @'
param(
  [int]$CapturePort = 4317,
  [int]$ServicePort = 4873,
  [int]$TriggerPort = 4881,
  [int]$ClientPort = 1432,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
  [switch]$WithQtDiagnostic,
  [switch]$StopExisting,
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "logs\integrated"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-LocalTcpPort {
  param([int]$Port)
  try {
    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
      $Async = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if (-not $Async.AsyncWaitHandle.WaitOne(500)) { return $false }
      $Client.EndConnect($Async)
      return $true
    } finally {
      $Client.Dispose()
    }
  } catch {
    return $false
  }
}

function Wait-HttpJson {
  param([string]$Name, [string]$Uri, [int]$TimeoutSec = 30)
  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec 3
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)
  throw "$Name did not become ready at $Uri within ${TimeoutSec}s."
}

function Wait-HttpHtml {
  param([string]$Name, [string]$Uri, [int]$TimeoutSec = 30)
  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec 3
      if ($Response.StatusCode -eq 200 -and [string]$Response.Content -match "<html") {
        return $Response
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)
  throw "$Name did not become ready at $Uri within ${TimeoutSec}s."
}

function Normalize-PathText {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  try {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
  } catch {
    return $Path.TrimEnd('\', '/').ToLowerInvariant()
  }
}

function Assert-CaptureProviderMatches {
  param([object]$Health, [string]$ExpectedStorageRoot, [string]$ExpectedConfigRoot)
  if ((Normalize-PathText ([string]$Health.storageRoot)) -ne (Normalize-PathText $ExpectedStorageRoot)) {
    throw "Capture provider on port $CapturePort uses storageRoot '$($Health.storageRoot)', expected '$ExpectedStorageRoot'. Stop it first or rerun with -StopExisting to avoid writing frames to the wrong root."
  }
  if ((Normalize-PathText ([string]$Health.configRoot)) -ne (Normalize-PathText $ExpectedConfigRoot)) {
    throw "Capture provider on port $CapturePort uses configRoot '$($Health.configRoot)', expected '$ExpectedConfigRoot'. Stop it first or rerun with -StopExisting to avoid loading the wrong profile."
  }
}

function Normalize-ProcessPathEnvironment {
  $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  if ([string]::IsNullOrEmpty($PathValue)) {
    $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if (-not [string]::IsNullOrEmpty($PathValue)) {
    [Environment]::SetEnvironmentVariable("Path", $PathValue, "Process")
  }
}

function Start-RuntimeScript {
  param([string]$Name, [string]$ScriptPath, [string[]]$Arguments)
  $OutLog = Join-Path $LogDir "$Name.out.log"
  $ErrLog = Join-Path $LogDir "$Name.err.log"
  $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
  Normalize-ProcessPathEnvironment
  $Process = Start-Process -FilePath "powershell.exe" -ArgumentList $ArgList -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  Write-Host "$Name started: PID $($Process.Id), logs $OutLog"
}

if ($StopExisting) {
  $StopScript = Join-Path $Root "stop-runtime.ps1"
  if (Test-Path $StopScript -PathType Leaf) {
    & $StopScript -Ports @($CapturePort, $ServicePort, $TriggerPort, $ClientPort)
  }
}

$CaptureScript = Join-Path $Root "run-capture-headless.ps1"
$ServiceScript = Join-Path $Root "run-service-headless.ps1"
$TriggerScript = Join-Path $Root "run-trigger-gateway.ps1"
$ClientScript = Join-Path $Root "run-client-static.ps1"

if (-not (Test-LocalTcpPort -Port $CapturePort)) {
  Start-RuntimeScript -Name "capture" -ScriptPath $CaptureScript -Arguments @("-Port", [string]$CapturePort, "-StorageRoot", $StorageRoot, "-CameraStorageRoot", $CameraStorageRoot)
} else {
  Write-Host "Capture provider already listening on port $CapturePort."
}
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
$ExpectedCaptureConfigRoot = Join-Path $Root "config\capture"
Assert-CaptureProviderMatches -Health $CaptureHealth -ExpectedStorageRoot $StorageRoot -ExpectedConfigRoot $ExpectedCaptureConfigRoot
Write-Host ("Capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)

if ($WithQtDiagnostic) {
  $QtDiagnosticScript = Join-Path $Root "run-capture-qt.ps1"
  if (-not (Test-Path $QtDiagnosticScript -PathType Leaf)) {
    throw "Qt diagnostic viewer is not included in this runtime. Sync with -IncludeQt or omit -WithQtDiagnostic."
  }
  Start-RuntimeScript -Name "capture-qt-diagnostic" -ScriptPath $QtDiagnosticScript -Arguments @("-Port", [string]$CapturePort, "-StorageRoot", $StorageRoot, "-CameraStorageRoot", $CameraStorageRoot)
}

if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-RuntimeScript -Name "service" -ScriptPath $ServiceScript -Arguments @("-Port", [string]$ServicePort, "-CaptureOrigin", "http://127.0.0.1:$CapturePort", "-TriggerOrigin", "http://127.0.0.1:$TriggerPort")
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
$ProductionStatus = Wait-HttpJson -Name "Rust service" -Uri "http://127.0.0.1:$ServicePort/api/production/status" -TimeoutSec 30
Write-Host ("Service ready: production code={0}" -f $ProductionStatus.code)

if (-not (Test-LocalTcpPort -Port $TriggerPort)) {
  Start-RuntimeScript -Name "trigger-gateway" -ScriptPath $TriggerScript -Arguments @("-Port", [string]$TriggerPort, "-InspectionServiceOrigin", "http://127.0.0.1:$ServicePort", "-Mode", $TriggerMode)
} else {
  Write-Host "Trigger gateway already listening on port $TriggerPort."
}
$TriggerStatus = Wait-HttpJson -Name "Trigger gateway" -Uri "http://127.0.0.1:$TriggerPort/api/trigger/status" -TimeoutSec 30
Write-Host ("Trigger gateway ready: mode={0}, manualAllowed={1}" -f $TriggerStatus.mode, $TriggerStatus.manualAllowed)

if ((Test-Path $ClientScript -PathType Leaf) -and -not (Test-LocalTcpPort -Port $ClientPort)) {
  Start-RuntimeScript -Name "client-static" -ScriptPath $ClientScript -Arguments @("-Port", [string]$ClientPort)
}

$ClientUrl = "http://127.0.0.1:$ClientPort/?app=terminal"
Wait-HttpHtml -Name "Static client" -Uri $ClientUrl -TimeoutSec 30 | Out-Null
Write-Host "Client ready: $ClientUrl"

if ($OpenBrowser) {
  Start-Process $ClientUrl | Out-Null
}

Write-Host ""
Write-Host "Integrated capture management is ready:"
Write-Host "  Capture API     http://127.0.0.1:$CapturePort"
Write-Host "  Rust service    http://127.0.0.1:$ServicePort"
Write-Host "  Trigger gateway http://127.0.0.1:$TriggerPort/manual"
Write-Host "  Client          $ClientUrl"
Write-Host "  Logs            $LogDir"
'@

Write-RuntimeFile "stop-runtime.ps1" @'
param(
  [int[]]$Ports = @(4317, 4873, 4881, 1432)
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

$ProcessNames = @(
  "steel-inspection-service",
  "steel-trigger-gateway",
  "steel_trigger_gateway",
  "steel_capture_service",
  "steel_capture_qt_terminal"
)

$Processes = @()
foreach ($Name in $ProcessNames) {
  $Processes += Get-Process -Name $Name -ErrorAction SilentlyContinue
}
foreach ($Port in $Ports) {
  foreach ($ProcessId in (Get-ListenerProcessIds -Port $Port)) {
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($Process) {
      $Processes += $Process
    }
  }
}

$Processes = @($Processes | Where-Object { $_ -and $_.Id -gt 4 -and $_.Id -ne $PID } | Sort-Object Id -Unique)
if (-not $Processes -or $Processes.Count -eq 0) {
  Write-Host "No steel inspection runtime processes found."
  return
}

$Processes | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
$Processes | Stop-Process -Force
Write-Host "Stopped $($Processes.Count) runtime process(es)."
'@

Write-RuntimeFile "README.md" @'
# Steel Inspection Target Runtime

This folder is generated by `scripts/sync-target-runtime.ps1`.

- `capture-headless/`: headless C++ provider plus `nvt_lvm_sdk.dll`.
- `capture-qt/`: optional diagnostic viewer plus Qt runtime DLLs and plugins when generated with `-IncludeQt`.
- `service/`: Rust service executable.
- `trigger/`: standalone trigger gateway executable.
- `client/`: built frontend files.
- `config/`: temporary target-local runtime config and SQLite database.
- `logs/`: runtime logs.

Recommended start order:

```powershell
.\run-capture-headless.ps1
.\run-service-headless.ps1
.\run-trigger-gateway.ps1 -Mode manual
```

One-command integrated startup:

```powershell
.\run-integrated-capture-management.ps1 -TriggerMode manual -OpenBrowser
```

Use `-StopExisting` when restarting the stack on the same ports.

Optional Qt diagnostic viewer after the headless provider is running:

```powershell
.\run-capture-qt.ps1
```

The Qt script sets `CAPTURE_QT_API_AUTOSTART=0`; it does not own the API or camera SDK session in the formal runtime.

The integrated script waits for capture, service, trigger health endpoints, and the built client page at `http://127.0.0.1:1432/?app=terminal` when `run-client-static.ps1` is present.

Stop the target runtime, including the PowerShell static client listener on `1432`:

```powershell
.\stop-runtime.ps1
```

Integrated smoke test without cameras:

```powershell
.\test-integrated-management-smoke.ps1
```

The smoke test starts the simulated Rust service, trigger gateway, and static client on temporary ports, then verifies manual guard, steel-info, steel-in, record-before-capture, steel-out, and terminal page availability.

Static runtime layout check without starting services:

```powershell
.\test-runtime-layout.ps1
```

Live ready check after starting the real stack:

```powershell
.\test-integrated-runtime-ready.ps1
```

Full integrated capture-management check after starting the real stack and client:

```powershell
.\test-integrated-capture-management-full.ps1
```

Add `-RunCapture`, `-RunBarSurface`, or `-RunShortStability` when a full production capture, 3D reconstruction, or production stability loop should be included. `-RequireFullCoverage` also requires real calibration apply/rollback, both crash Resume reports, and the integrity/generation report.

```powershell
.\test-integrated-capture-management-full.ps1 -RunShortStability -StabilityUseTriggerGateway -RunBarSurface -RequireFullCoverage -StabilityDurationSec 600 -StabilityIntervalSec 2
```

For a shorter full-coverage acceptance run, keep the same switches and use `-StabilityDurationSec 45 -StabilityIntervalSec 0`. The JSON report includes `coverage.full`, `coverage.covered`, `coverage.required`, and per-item skipped/uncovered reasons.

Live UI smoke test after starting the real stack and client:

```powershell
.\test-runtime-ui-smoke.ps1 -ClientOrigin http://127.0.0.1:1432/?app=terminal
```

This verifies the terminal, capture, and 3D reconstruction pages, including the monitoring-only realtime upload, realtime download, and bandwidth fields in the receiver network popover.

One-command folder acceptance:

```powershell
.\test-runtime-acceptance.ps1
```

Real hardware read-only checks, with optional `-RunCapture` for one production capture round:

```powershell
.\test-real-hardware-acceptance.ps1
.\test-real-hardware-acceptance.ps1 -RunCapture
```

Authenticated calibration dry-run and separately authorized apply/rollback:

```powershell
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\six-camera-calibration-plan.json -AdminToken $adminToken
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\six-camera-calibration-plan.json -AdminToken $adminToken -RunApplyRollback -SafetyConfirmation "RUN REAL SIX CAMERA CALIBRATION APPLY AND ROLLBACK"
```

Controlled crash recovery (run once for ApplyCrash and once for RollbackCrash):

```powershell
.\test-real-calibration-crash-recovery.ps1 -Mode Prepare -Scenario ApplyCrash -PlanPath C:\maintenance\six-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
.\test-real-calibration-crash-recovery.ps1 -Mode Resume -StatePath .\logs\real-calibration-crash-recovery\active-calibration-crash-drill.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
```

Real stale-generation and staged-hash zero-write drill:

```powershell
.\test-real-calibration-integrity-generation.ps1 -PlanPath C:\maintenance\six-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN REAL CALIBRATION INTEGRITY AND GENERATION DRILL"
```
'@

$Manifest = [ordered]@{
  name = "steel-inspection-target-runtime"
  generatedAt = (Get-Date).ToString("o")
  root = "target/runtime"
  configRoot = "target/runtime/config"
  captureHeadless = "capture-headless/steel_capture_service.exe"
  captureQt = if ($IncludeQt) { "capture-qt/steel_capture_qt_terminal.exe" } else { $null }
  captureQtRole = if ($IncludeQt) { "diagnostic-only" } else { $null }
  captureQtOwnsApi = if ($IncludeQt) { $false } else { $null }
  captureQtFormalRuntime = if ($IncludeQt) { $false } else { $null }
  formalCapture = "headless-cpp"
  captureRole = "formal-sdk-owner"
  service = "service/steel-inspection-service.exe"
  triggerGateway = "trigger/steel-trigger-gateway.exe"
  client = "client/index.html"
  algorithmCore = "algorithm-core/steel_bar_surface_core.exe"
  algorithmScripts = "scripts"
  clientStatic = "run-client-static.ps1"
  integrated = "run-integrated-capture-management.ps1"
  integratedSmokeTest = "test-integrated-management-smoke.ps1"
  integratedReadyTest = "test-integrated-runtime-ready.ps1"
  integratedFullAcceptanceTest = "test-integrated-capture-management-full.ps1"
  integratedAcceptanceAuditTest = "test-integrated-acceptance-audit.ps1"
  migrationArchitectureTest = "test-architecture-migration-contract.ps1"
  runtimeAcceptanceTest = "test-runtime-acceptance.ps1"
  runtimeLayoutTest = "test-runtime-layout.ps1"
  runtimeUiSmokeTest = "test-runtime-ui-smoke.ps1"
  realHardwareAcceptanceTest = "test-real-hardware-acceptance.ps1"
  realCalibrationAcceptanceTest = "test-real-calibration-acceptance.ps1"
  realCalibrationCrashRecoveryTest = "test-real-calibration-crash-recovery.ps1"
  realCalibrationIntegrityGenerationTest = "test-real-calibration-integrity-generation.ps1"
  productionStabilityTest = "test-production-stability.ps1"
  barSurfaceE2ETest = "scripts/test-bar-surface-e2e.ps1"
  migrationArchitecture = $MigrationArchitecture
  dlls = @{
    captureSdk = "capture-headless/nvt_lvm_sdk.dll"
    qtSdk = if ($IncludeQt) { "capture-qt/nvt_lvm_sdk.dll" } else { $null }
  }
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $RuntimeRoot "manifest.json") -Encoding UTF8

Write-Host "Target runtime synchronized at $RuntimeRoot"
