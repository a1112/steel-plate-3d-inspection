param(
  [ValidateSet("headless-cpp", "external-api", "simulated")]
  [string]$Provider = "headless-cpp",
  [string]$CaptureOrigin = "",
  [string]$CaptureExe = "",
  [string]$CaptureConfigRoot = "",
  [string]$CaptureStorageRoot = "",
  [string]$CameraStorageRoot = "",
  [string]$TriggerOrigin = "",
  [string]$HostAddress = "0.0.0.0",
  [int]$Port = 4873,
  [int]$HttpsPort = 0,
  [string]$TlsCertificate = "",
  [string]$TlsPrivateKey = "",
  [string]$WebRoot = "",
  [switch]$NoCaptureAutostart,
  [switch]$ManagementOnly,
  [ValidateRange(1, 20)]
  [int]$CaptureRestartBudget = 5,
  [ValidateRange(100, 30000)]
  [int]$CaptureRestartBackoffMs = 1000,
  [ValidateRange(1000, 120000)]
  [int]$CaptureReadyTimeoutMs = 15000,
  [string]$EnvFile = "",
  [string]$RuntimeProfile = "",
  [string]$AlgorithmMode = "",
  [ValidateSet("", "sqlite", "mysql", "postgres")]
  [string]$DatabaseEngine = "",
  [ValidateSet("", "none", "sqlite")]
  [string]$DatabaseFallback = "",
  [ValidateRange(100, 30000)]
  [int]$DatabaseConnectTimeoutMs = 5000,
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$ServiceExe = "",
  [string]$ServicePidFile = "",
  [switch]$Detach,
  [string]$ConfigRoot = "",
  [string]$ArtifactAllowedRoots = "",
  [string]$AlgorithmRoot = "",
  [string]$AlgorithmConfigPath = "",
  [string]$AlgorithmCalibrationPath = "",
  [string]$AlgorithmCaptureRoot = "",
  [string]$RuntimeStateRoot = "",
  [string]$RuntimeLogDir = "",
  [string]$ResultRoot = "",
  [string]$AlgorithmInputRoot = "",
  [string]$InspectionWorldCacheRoot = "",
  [switch]$ResultProxyOnly,
  [ValidateRange(10, 7200)]
  [int]$AlgorithmProcessTimeoutSec = 1800,
  [switch]$ForceParameters
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

if ($ManagementOnly) {
  # Management-only is a one-way safety mode: the business API and admin UI
  # remain available, while neither startup policy nor an admin service action
  # may launch or mutate the physical capture process.
  $NoCaptureAutostart = $true
  $ResultProxyOnly = $true
  $env:STEEL_BACKGROUND_MANAGEMENT_ONLY = "1"
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
  $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "0"
}
$ResultProxyOnlyEnabled = $ResultProxyOnly -or $env:STEEL_RESULT_PROXY_ONLY -eq "1"

# These values are intentionally applied after EnvFile import.  The Tauri
# development launcher owns the local split-runtime directories and must not
# be silently redirected to stale paths from a production environment file.
if ($RuntimeStateRoot.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $RuntimeStateRoot | Out-Null
  $env:STEEL_RUNTIME_STATE_ROOT = (Resolve-Path $RuntimeStateRoot).Path
}
if ($RuntimeLogDir.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $RuntimeLogDir | Out-Null
  $env:STEEL_RUNTIME_LOG_DIR = (Resolve-Path $RuntimeLogDir).Path
}
if ($ResultRoot.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $ResultRoot | Out-Null
  $env:STEEL_RESULT_ROOT = (Resolve-Path $ResultRoot).Path
}
if ($AlgorithmInputRoot.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $AlgorithmInputRoot | Out-Null
  $env:STEEL_ALGORITHM_INPUT_ROOTS = (Resolve-Path $AlgorithmInputRoot).Path
}
if ($InspectionWorldCacheRoot.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $InspectionWorldCacheRoot | Out-Null
  $env:STEEL_INSPECTION_WORLD_CACHE_ROOT = (Resolve-Path $InspectionWorldCacheRoot).Path
}
if ($ResultProxyOnlyEnabled) {
  $env:STEEL_RESULT_PROXY_ONLY = "1"
  $env:STEEL_IMAGE_PROXY = "1"
  $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "1"
  # The inspection service is the business/result proxy in this mode. Remove
  # inherited raw BKV credentials before creating its process so only the
  # separately launched adapter can access MySQL or image shares.
  Get-ChildItem Env: |
    Where-Object { $_.Name -like "STEEL_BKV_*" } |
    ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" -ErrorAction SilentlyContinue }
}
if ($ManagementOnly) {
  # Result-proxy compatibility must not turn capture-supervisor ownership back
  # on after the management-only fence was selected.
  $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "0"
}

if (-not [string]::IsNullOrWhiteSpace($RuntimeProfile)) {
  if ($RuntimeProfile -notin @("development", "acceptance", "production")) {
    throw "RuntimeProfile must be development, acceptance, or production."
  }
  $env:STEEL_RUNTIME_PROFILE = $RuntimeProfile
}
if (-not [string]::IsNullOrWhiteSpace($AlgorithmMode)) {
  if ($AlgorithmMode -notin @("demo", "validation", "production")) {
    throw "AlgorithmMode must be demo, validation, or production."
  }
  $env:STEEL_ALGORITHM_MODE = $AlgorithmMode
}
if (-not [string]::IsNullOrWhiteSpace($DatabaseEngine)) {
  $env:STEEL_DATABASE_ENGINE = $DatabaseEngine
}
if (-not [string]::IsNullOrWhiteSpace($DatabaseFallback)) {
  if ($DatabaseFallback -eq "sqlite" -and $env:STEEL_RUNTIME_PROFILE -eq "production") {
    throw "SQLite database fallback is forbidden in production."
  }
  $env:STEEL_DATABASE_FALLBACK = $DatabaseFallback
}
if ($ForceParameters -or -not $env:STEEL_DATABASE_CONNECT_TIMEOUT_MS) {
  $env:STEEL_DATABASE_CONNECT_TIMEOUT_MS = [string]$DatabaseConnectTimeoutMs
}

if ($ConfigRoot.Trim().Length -eq 0) {
  $ConfigRoot = Join-Path $RepoRoot "target\config\service"
}
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
$ServiceRegistrySource = Join-Path $RepoRoot "config\service-registry.json"
$ServiceRegistryDestination = Join-Path $ConfigRoot "service-registry.json"
if (-not (Test-Path -LiteralPath $ServiceRegistryDestination -PathType Leaf) -and
    (Test-Path -LiteralPath $ServiceRegistrySource -PathType Leaf)) {
  Copy-Item -LiteralPath $ServiceRegistrySource -Destination $ServiceRegistryDestination -Force
}

if ($ForceParameters -or -not $env:INSPECTION_SERVICE_PORT) {
  $env:INSPECTION_SERVICE_PORT = [string]$Port
}
if ($ForceParameters -or -not $env:INSPECTION_SERVICE_HOST) {
  $env:INSPECTION_SERVICE_HOST = $HostAddress
}
if ($HttpsPort -gt 0) {
  if (-not (Test-Path -LiteralPath $TlsCertificate -PathType Leaf)) {
    throw "HTTPS requires a PEM certificate file: $TlsCertificate"
  }
  if (-not (Test-Path -LiteralPath $TlsPrivateKey -PathType Leaf)) {
    throw "HTTPS requires a PEM private key file: $TlsPrivateKey"
  }
  $env:INSPECTION_SERVICE_HTTPS_PORT = [string]$HttpsPort
  $env:INSPECTION_SERVICE_TLS_CERT = (Resolve-Path -LiteralPath $TlsCertificate).Path
  $env:INSPECTION_SERVICE_TLS_KEY = (Resolve-Path -LiteralPath $TlsPrivateKey).Path
}
if ($WebRoot.Trim().Length -gt 0) {
  if (-not (Test-Path -LiteralPath (Join-Path $WebRoot 'index.html') -PathType Leaf)) {
    throw "WebRoot must contain index.html: $WebRoot"
  }
  $env:STEEL_WEB_ROOT = (Resolve-Path -LiteralPath $WebRoot).Path
}
if ($ForceParameters -or -not $env:STEEL_CAPTURE_PROVIDER) {
  $env:STEEL_CAPTURE_PROVIDER = $Provider
}

if ($CaptureOrigin.Trim().Length -gt 0) {
  $env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin
}
if ($CaptureExe.Trim().Length -gt 0) {
  if (-not (Test-Path $CaptureExe -PathType Leaf)) {
    throw "Missing managed capture executable: $CaptureExe"
  }
  $env:STEEL_CAPTURE_SERVICE_EXE = (Resolve-Path $CaptureExe).Path
}
if ($CaptureConfigRoot.Trim().Length -gt 0) {
  New-Item -ItemType Directory -Force -Path $CaptureConfigRoot | Out-Null
  $env:CAPTURE_CONFIG_ROOT = (Resolve-Path $CaptureConfigRoot).Path
}
if ($CaptureStorageRoot.Trim().Length -gt 0) {
  $env:CAPTURE_STORAGE_ROOT = $CaptureStorageRoot
}
if ($CameraStorageRoot.Trim().Length -gt 0) {
  $env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
}
if ($TriggerOrigin.Trim().Length -gt 0) {
  $env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
}

if ($NoCaptureAutostart) {
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
} elseif ($Provider -eq "headless-cpp" -and ($ForceParameters -or -not $env:STEEL_CAPTURE_SERVICE_AUTOSTART)) {
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "1"
}
$env:STEEL_CAPTURE_RESTART_BUDGET = [string]$CaptureRestartBudget
$env:STEEL_CAPTURE_RESTART_BACKOFF_MS = [string]$CaptureRestartBackoffMs
$env:STEEL_CAPTURE_READY_TIMEOUT_MS = [string]$CaptureReadyTimeoutMs

if ($ArtifactAllowedRoots.Trim().Length -gt 0) {
  $env:STEEL_ARTIFACT_ALLOWED_ROOTS = $ArtifactAllowedRoots
}

if ($AlgorithmRoot.Trim().Length -gt 0) {
  $env:STEEL_ALGORITHM_DATA_ROOT = $AlgorithmRoot
}
if ($AlgorithmConfigPath.Trim().Length -gt 0) {
  $env:STEEL_ALGORITHM_CONFIG = $AlgorithmConfigPath
}
if ($AlgorithmCalibrationPath.Trim().Length -gt 0) {
  $env:STEEL_ALGORITHM_CALIBRATION_PATH = $AlgorithmCalibrationPath
}
if ($AlgorithmCaptureRoot.Trim().Length -gt 0) {
  $env:STEEL_BAR_CAPTURE_ROOT = $AlgorithmCaptureRoot
}
if ($ForceParameters -or -not $env:STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC) {
  $env:STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC = [string]$AlgorithmProcessTimeoutSec
}

$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
if ([string]::IsNullOrWhiteSpace($ServiceExe)) {
  $ServiceExe = Join-Path $RepoRoot "target\cargo\$Profile\steel-inspection-service.exe"
}
if (-not (Test-Path -LiteralPath $ServiceExe -PathType Leaf)) {
  throw "Missing $ServiceExe. Run scripts/build-service.ps1 -Profile $Profile first."
}
$ServiceExe = (Resolve-Path -LiteralPath $ServiceExe).Path

if ([string]::IsNullOrWhiteSpace($ServicePidFile)) {
  if ($Detach) {
    throw "-Detach requires -ServicePidFile so the background service remains trackable."
  }
  & $ServiceExe
  exit $LASTEXITCODE
}

$ServicePidFile = [System.IO.Path]::GetFullPath($ServicePidFile)
$servicePidDirectory = Split-Path -Parent $ServicePidFile
New-Item -ItemType Directory -Force -Path $servicePidDirectory | Out-Null
$detachedStdoutPath = $null
$detachedStderrPath = $null
if ($Detach) {
  $detachedLogDirectory = if ($RuntimeLogDir.Trim().Length -gt 0) {
    [System.IO.Path]::GetFullPath($RuntimeLogDir)
  } else {
    Join-Path $servicePidDirectory "logs"
  }
  New-Item -ItemType Directory -Force -Path $detachedLogDirectory | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $detachedStdoutPath = Join-Path $detachedLogDirectory "inspection-service-$stamp.out.log"
  $detachedStderrPath = Join-Path $detachedLogDirectory "inspection-service-$stamp.err.log"
  $serviceProcess = Start-Process `
    -FilePath $ServiceExe `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $detachedStdoutPath `
    -RedirectStandardError $detachedStderrPath `
    -PassThru
  [System.IO.File]::WriteAllText($ServicePidFile, [string]$serviceProcess.Id)
  Write-Host "steel-inspection-service detached with PID $($serviceProcess.Id)"
  Write-Host "service logs: $detachedStdoutPath"
  exit 0
}
$serviceProcess = Start-Process -FilePath $ServiceExe -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
try {
  [System.IO.File]::WriteAllText($ServicePidFile, [string]$serviceProcess.Id)
  $serviceProcess.WaitForExit()
  exit $serviceProcess.ExitCode
} finally {
  Remove-Item -LiteralPath $ServicePidFile -Force -ErrorAction SilentlyContinue
}
