param(
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "release"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$RuntimeRoot = Join-Path $RepoRoot "target\runtime"
$CaptureOut = Join-Path $RuntimeRoot "capture-headless"
$ServiceOut = Join-Path $RuntimeRoot "service"
$TriggerOut = Join-Path $RuntimeRoot "trigger"
$ClientOut = Join-Path $RuntimeRoot "client"
$ConfigOut = Join-Path $RuntimeRoot "config"
$LogsOut = Join-Path $RuntimeRoot "logs"
$ScriptsOut = Join-Path $RuntimeRoot "scripts"
$DocsOut = Join-Path $RuntimeRoot "docs"
$AlgorithmCoreOut = Join-Path $RuntimeRoot "algorithm-core"
$DatabaseOut = Join-Path $RuntimeRoot "database"

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

$DatabaseContractVerifier = Join-Path $RepoRoot "scripts\verify-database-migration-contract.ps1"
$DatabaseContractTest = Join-Path $RepoRoot "scripts\test-database-migration-contract.ps1"
$DatabaseContractSource = Join-Path $RepoRoot "config\release\database\contract.json"
$DatabaseMigrationIndexSource = Join-Path $RepoRoot "config\release\database\migrations\index.json"
$DatabaseContractReportText = (& $DatabaseContractVerifier `
  -ContractPath $DatabaseContractSource `
  -IndexPath $DatabaseMigrationIndexSource | Out-String)
$DatabaseContractReport = $DatabaseContractReportText | ConvertFrom-Json
if ($DatabaseContractReport.code -ne 0) {
  throw "Database contract validation failed before runtime synchronization."
}
$DatabaseContract = Get-Content -LiteralPath $DatabaseContractSource -Raw -Encoding UTF8 | ConvertFrom-Json
$ServiceDatabaseSource = Get-Content -LiteralPath (Join-Path $RepoRoot "app\service\src\db\mod.rs") -Raw -Encoding UTF8
$ServiceSchemaVersionMatches = [regex]::Matches(
  $ServiceDatabaseSource,
  '(?m)^pub const DATABASE_SCHEMA_VERSION: i64 = ([1-9][0-9]*);$'
)
if ($ServiceSchemaVersionMatches.Count -ne 1 -or
    [long]$DatabaseContract.schemaVersion -ne [long]$ServiceSchemaVersionMatches[0].Groups[1].Value) {
  throw "Database target-runtime contract must match the Rust DATABASE_SCHEMA_VERSION."
}

if (Test-Path $RuntimeRoot) {
  $ResolvedRuntime = Resolve-Path $RuntimeRoot
  $ResolvedTarget = Resolve-Path (Join-Path $RepoRoot "target")
  if (-not $ResolvedRuntime.Path.StartsWith($ResolvedTarget.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove runtime directory outside target: $ResolvedRuntime"
  }
  Remove-Item -LiteralPath $ResolvedRuntime.Path -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CaptureOut, $ServiceOut, $TriggerOut, $ClientOut, $ConfigOut, $LogsOut, $ScriptsOut, $DocsOut, $AlgorithmCoreOut, $DatabaseOut | Out-Null

Copy-Item -LiteralPath $DatabaseContractSource -Destination (Join-Path $DatabaseOut "contract.json") -Force
Copy-Item -LiteralPath (Split-Path -Parent $DatabaseMigrationIndexSource) -Destination $DatabaseOut -Recurse -Force
$PackagedDatabaseContractPath = Join-Path $DatabaseOut "contract.json"
$PackagedDatabaseMigrationIndexPath = Join-Path $DatabaseOut "migrations\index.json"
$PackagedDatabaseContractHash = (Get-FileHash -LiteralPath $PackagedDatabaseContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
$PackagedDatabaseMigrationIndexHash = (Get-FileHash -LiteralPath $PackagedDatabaseMigrationIndexPath -Algorithm SHA256).Hash.ToLowerInvariant()
[void](& $DatabaseContractVerifier `
  -ContractPath $PackagedDatabaseContractPath `
  -IndexPath $PackagedDatabaseMigrationIndexPath | Out-String)

$CaptureBuild = Join-Path $RepoRoot "target\capture\$Configuration"
Copy-RequiredFile (Join-Path $CaptureBuild "steel_capture_service.exe") $CaptureOut
Copy-RequiredFile (Join-Path $CaptureBuild "nvt_lvm_sdk.dll") $CaptureOut
Copy-RequiredFile (Join-Path $CaptureBuild "steel_runtime_supervisor.exe") $ServiceOut
Rename-Item -LiteralPath (Join-Path $ServiceOut "steel_runtime_supervisor.exe") -NewName "steel-runtime-supervisor.exe"

$ServiceBuild = Join-Path $RepoRoot "target\cargo\$ServiceProfile"
Copy-RequiredFile (Join-Path $ServiceBuild "steel-inspection-service.exe") $ServiceOut

$TriggerBuild = Join-Path $RepoRoot "target\trigger\$ServiceProfile"
Copy-RequiredFile (Join-Path $TriggerBuild "steel-trigger-gateway.exe") $TriggerOut
Copy-RequiredFile (Join-Path $TriggerBuild "steel-trigger-gateway.exe") $ServiceOut
$AlgorithmServiceBuild = Join-Path $RepoRoot "target\algorithm-service\$ServiceProfile"
Copy-RequiredFile (Join-Path $AlgorithmServiceBuild "steel-algorithm-service.exe") $ServiceOut
$ImageServiceBuild = Join-Path $RepoRoot "target\image-service\$ServiceProfile"
Copy-RequiredFile (Join-Path $ImageServiceBuild "steel-image-service.exe") $ServiceOut
$TrayBuild = Join-Path $RepoRoot "target\tray\$ServiceProfile"
Copy-RequiredFile (Join-Path $TrayBuild "steel-inspection-tray.exe") $ServiceOut

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
if (Test-Path (Join-Path $RepoRoot "config\algorithm") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\algorithm") -Destination $ConfigOut -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "config\acceptance") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\acceptance") -Destination $ConfigOut -Recurse -Force
}
Copy-RequiredFile (Join-Path $RepoRoot "scripts\run-client-static.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-trigger-gateway-security.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-acceptance-audit.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-supervisor.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-algorithm-acceptance-report.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-go-live-readiness.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\new-functional-scenario-evidence.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\new-functional-acceptance-workspace.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-acceptance-workspace-contract.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\add-functional-scenario-evidence.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-scenario-attachment-contract.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test_algorithm_traceability.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\install-runtime-service.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\uninstall-runtime-service.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability-workroot-contract.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\backup-database.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\restore-database.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\manage-report-archives.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-report-archive-recovery.ps1") $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\database-recovery-common.ps1") $RuntimeRoot
Copy-RequiredFile $DatabaseContractVerifier $RuntimeRoot
Copy-RequiredFile $DatabaseContractTest $RuntimeRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\bar_surface_reconstruct.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\fit_array_calibration_cross_section.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\independent-architecture.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\capture-api-contract.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\integrated-capture-management-acceptance.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\qt-to-tauri-migration.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\release-deployment-and-operations.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\production-readiness-gap-and-closure-design.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "docs\atomic-upgrade-and-database-migration-design.md") $DocsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\README.md") $ScriptsOut

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

Write-RuntimeFile "run-service-headless.ps1" @'
param(
  [int]$Port = 4873,
  [int]$CapturePort = 4317,
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "headless-cpp"
$env:CAPTURE_SERVICE_ORIGIN = "http://127.0.0.1:$CapturePort"
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "1"
$env:STEEL_CAPTURE_SERVICE_EXE = Join-Path $Root "capture-headless\steel_capture_service.exe"
$env:STEEL_CAPTURE_RESTART_BUDGET = "5"
$env:STEEL_CAPTURE_RESTART_BACKOFF_MS = "1000"
$env:STEEL_CAPTURE_READY_TIMEOUT_MS = "15000"
$env:CAPTURE_STORAGE_ROOT = $StorageRoot
$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:STEEL_RUNTIME_PROFILE = "production"
$env:STEEL_ALGORITHM_MODE = "production"
$env:BAR_SURFACE_MOCK_DEFECT_COUNT = "0"
$env:STEEL_TRIGGER_HEALTH_REQUIRED = "1"
$env:STEEL_STORAGE_MIN_FREE_BYTES = "21474836480"
$env:STEEL_STORAGE_MIN_FREE_PERCENT = "10"
$env:STEEL_ARTIFACT_ALLOWED_ROOTS = $ArtifactAllowedRoots
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
$env:STEEL_SERVICE_CONFIG_DIR = Join-Path $Root "config\service"
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null

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
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$Mode = "manual",
  [ValidateSet("development", "acceptance", "production")]
  [string]$RuntimeProfile = "production",
  [string]$SourceAllowlist = "",
  [switch]$AllowModeMutation
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "trigger\steel-trigger-gateway.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing trigger gateway executable: $Exe"
}

$env:TRIGGER_GATEWAY_PORT = [string]$Port
$env:TRIGGER_GATEWAY_HOST = $HostAddress
$env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
$env:TRIGGER_MODE = $Mode
$env:STEEL_RUNTIME_PROFILE = $RuntimeProfile
$env:TRIGGER_SOURCE_ALLOWLIST = $SourceAllowlist
$env:TRIGGER_ALLOW_MODE_MUTATION = if ($AllowModeMutation) { "1" } else { "0" }

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
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots,
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
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

$ServiceScript = Join-Path $Root "run-service-headless.ps1"
$TriggerScript = Join-Path $Root "run-trigger-gateway.ps1"
$ClientScript = Join-Path $Root "run-client-static.ps1"

if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-RuntimeScript -Name "service" -ScriptPath $ServiceScript -Arguments @("-Port", [string]$ServicePort, "-CapturePort", [string]$CapturePort, "-TriggerOrigin", "http://127.0.0.1:$TriggerPort", "-StorageRoot", $StorageRoot, "-CameraStorageRoot", $CameraStorageRoot, "-ArtifactAllowedRoots", $ArtifactAllowedRoots)
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
$CaptureLifecycle = Wait-HttpJson -Name "Managed capture lifecycle" -Uri "http://127.0.0.1:$ServicePort/api/capture/lifecycle" -TimeoutSec 30
if ([string]$CaptureLifecycle.lifecycle.phase -ne "ready") {
  throw "Managed capture lifecycle is '$($CaptureLifecycle.lifecycle.phase)': $($CaptureLifecycle.lifecycle.lastError)"
}
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
$ExpectedCaptureConfigRoot = Join-Path $Root "config\capture"
Assert-CaptureProviderMatches -Health $CaptureHealth -ExpectedStorageRoot $StorageRoot -ExpectedConfigRoot $ExpectedCaptureConfigRoot
Write-Host ("Managed capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)
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
  [int[]]$Ports = @(4317, 4873, 4874, 4875, 4881, 1432)
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
  "steel_capture_service"
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
- `service/`: Rust service executable.
- `trigger/`: standalone trigger gateway executable.
- `client/`: built frontend files.
- `config/`: temporary target-local runtime config and SQLite database.
- `logs/`: runtime logs.

Recommended start order:

The target trigger gateway defaults to `STEEL_RUNTIME_PROFILE=production`. Inject different values for `TRIGGER_SHARED_SECRET` and `TRIGGER_OPERATOR_TOKEN`, each with at least 32 random bytes, through the service manager before starting it; non-loopback binding also requires `TRIGGER_SOURCE_ALLOWLIST`. The shared secret authenticates PLC/L2 traffic, while the operator token is only for the loopback Rust-to-gateway hop. Runtime mode mutation remains locked unless an approved maintenance run explicitly passes `-AllowModeMutation`.

```powershell
.\run-service-headless.ps1 -ArtifactAllowedRoots "H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;H:\production;H:\reconstruction"
.\run-trigger-gateway.ps1 -Mode manual
```

The Rust service owns the capture child process and exposes its lifecycle at
`/api/capture/lifecycle`.

One-command integrated startup:

```powershell
.\run-integrated-capture-management.ps1 -ArtifactAllowedRoots "H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;H:\production;H:\reconstruction" -TriggerMode manual -OpenBrowser
```

Use `-StopExisting` when restarting the stack on the same ports.

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

Production trigger security gate:

```powershell
.\test-trigger-gateway-security.ps1
```

This isolated gate verifies fail-closed secret validation, HMAC-SHA256 and replay protection for HTTP/TCP/UDP, source policy, mode locking, status redaction, and absence of wildcard CORS.

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
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -RunApplyRollback -SafetyConfirmation "RUN REAL EIGHT CAMERA CALIBRATION APPLY AND ROLLBACK"
```

Controlled crash recovery (run once for ApplyCrash and once for RollbackCrash):

```powershell
.\test-real-calibration-crash-recovery.ps1 -Mode Prepare -Scenario ApplyCrash -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
.\test-real-calibration-crash-recovery.ps1 -Mode Resume -StatePath .\logs\real-calibration-crash-recovery\active-calibration-crash-drill.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
```

Real stale-generation and staged-hash zero-write drill:

```powershell
.\test-real-calibration-integrity-generation.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN REAL CALIBRATION INTEGRITY AND GENERATION DRILL"
```
'@

$Manifest = [ordered]@{
  name = "steel-inspection-target-runtime"
  generatedAt = (Get-Date).ToString("o")
  root = "target/runtime"
  configRoot = "target/runtime/config"
  captureHeadless = "capture-headless/steel_capture_service.exe"
  formalCapture = "headless-cpp"
  captureRole = "formal-sdk-owner"
  service = "service/steel-inspection-service.exe"
  triggerGateway = "trigger/steel-trigger-gateway.exe"
  serviceTriggerGateway = "service/steel-trigger-gateway.exe"
  supervisor = "service/steel-runtime-supervisor.exe"
  windowsServiceName = "SteelInspectionRuntime"
  client = "client/index.html"
  algorithmCore = "algorithm-core/steel_bar_surface_core.exe"
  algorithmConfig = "config/algorithm/bar-surface-production.json"
  algorithmAcceptanceTemplate = "config/algorithm/acceptance-report.example.json"
  functionalGoLivePlanTemplate = "config/acceptance/functional-go-live-plan.example.json"
  plcL2FunctionalAcceptanceTemplate = "config/acceptance/plc-l2-functional-acceptance.example.json"
  targetMachineFunctionalAcceptanceTemplate = "config/acceptance/target-machine-functional-acceptance.example.json"
  functionalScenarioEvidenceTemplate = "config/acceptance/functional-scenario-evidence.example.json"
  algorithmScripts = "scripts"
  clientStatic = "run-client-static.ps1"
  integrated = "run-integrated-capture-management.ps1"
  integratedSmokeTest = "test-integrated-management-smoke.ps1"
  triggerSecurityTest = "test-trigger-gateway-security.ps1"
  integratedReadyTest = "test-integrated-runtime-ready.ps1"
  integratedFullAcceptanceTest = "test-integrated-capture-management-full.ps1"
  integratedAcceptanceAuditTest = "test-integrated-acceptance-audit.ps1"
  migrationArchitectureTest = "test-architecture-migration-contract.ps1"
  runtimeAcceptanceTest = "test-runtime-acceptance.ps1"
  runtimeLayoutTest = "test-runtime-layout.ps1"
  runtimeSupervisorTest = "test-runtime-supervisor.ps1"
  algorithmAcceptanceTest = "test-algorithm-acceptance-report.ps1"
  functionalGoLiveReadinessTest = "test-functional-go-live-readiness.ps1"
  functionalScenarioEvidenceGenerator = "new-functional-scenario-evidence.ps1"
  functionalAcceptanceWorkspaceInitializer = "new-functional-acceptance-workspace.ps1"
  functionalAcceptanceWorkspaceContractTest = "test-functional-acceptance-workspace-contract.ps1"
  functionalScenarioEvidenceAttacher = "add-functional-scenario-evidence.ps1"
  functionalScenarioAttachmentContractTest = "test-functional-scenario-attachment-contract.ps1"
  algorithmTraceabilityTest = "scripts/test_algorithm_traceability.py"
  installRuntimeService = "install-runtime-service.ps1"
  uninstallRuntimeService = "uninstall-runtime-service.ps1"
  runtimeUiSmokeTest = "test-runtime-ui-smoke.ps1"
  realHardwareAcceptanceTest = "test-real-hardware-acceptance.ps1"
  realCalibrationAcceptanceTest = "test-real-calibration-acceptance.ps1"
  realCalibrationCrashRecoveryTest = "test-real-calibration-crash-recovery.ps1"
  realCalibrationIntegrityGenerationTest = "test-real-calibration-integrity-generation.ps1"
  productionStabilityTest = "test-production-stability.ps1"
  productionStabilityWorkRootContractTest = "test-production-stability-workroot-contract.ps1"
  databaseBackup = "backup-database.ps1"
  databaseRestore = "restore-database.ps1"
  reportArchiveRecovery = "manage-report-archives.ps1"
  reportArchiveRecoveryTest = "test-report-archive-recovery.ps1"
  databaseRecoveryCommon = "database-recovery-common.ps1"
  databaseContractVerify = "verify-database-migration-contract.ps1"
  databaseContractTest = "test-database-migration-contract.ps1"
  barSurfaceE2ETest = "scripts/test-bar-surface-e2e.ps1"
  database = [ordered]@{
    contractPath = "database/contract.json"
    contractSha256 = $PackagedDatabaseContractHash
    contractSchema = [string]$DatabaseContract.contractSchema
    schemaVersion = [int]$DatabaseContract.schemaVersion
    minUpgradeableSchemaVersion = [int]$DatabaseContract.minUpgradeableSchemaVersion
    maxUpgradeableSchemaVersion = [int]$DatabaseContract.maxUpgradeableSchemaVersion
    minReadableSchemaVersion = [int]$DatabaseContract.minReadableSchemaVersion
    maxReadableSchemaVersion = [int]$DatabaseContract.maxReadableSchemaVersion
    rollbackReadableThrough = [int]$DatabaseContract.rollbackReadableThrough
    engines = @($DatabaseContract.engines)
    migrationIndex = [string]$DatabaseContract.migrationIndex
    migrationIndexSha256 = $PackagedDatabaseMigrationIndexHash
    stateLayoutVersion = [int]$DatabaseContract.stateLayoutVersion
  }
  migrationArchitecture = $MigrationArchitecture
  dlls = @{
    captureSdk = "capture-headless/nvt_lvm_sdk.dll"
  }
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $RuntimeRoot "manifest.json") -Encoding UTF8

Write-Host "Target runtime synchronized at $RuntimeRoot"
