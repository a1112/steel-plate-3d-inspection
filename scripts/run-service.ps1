param(
  [ValidateSet("headless-cpp", "external-api", "simulated")]
  [string]$Provider = "headless-cpp",
  [string]$CaptureOrigin = "",
  [string]$CaptureExe = "",
  [string]$CaptureConfigRoot = "",
  [string]$CaptureStorageRoot = "",
  [string]$CameraStorageRoot = "",
  [string]$TriggerOrigin = "",
  [int]$Port = 4873,
  [switch]$NoCaptureAutostart,
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
if ($ResultProxyOnly) {
  $env:STEEL_RESULT_PROXY_ONLY = "1"
  $env:STEEL_IMAGE_PROXY = "1"
  $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "1"
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

if ($ForceParameters -or -not $env:INSPECTION_SERVICE_PORT) {
  $env:INSPECTION_SERVICE_PORT = [string]$Port
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
$ServiceExe = Join-Path $RepoRoot "target\cargo\$Profile\steel-inspection-service.exe"
if (-not (Test-Path $ServiceExe -PathType Leaf)) {
  throw "Missing $ServiceExe. Run scripts/build-service.ps1 -Profile $Profile first."
}

& $ServiceExe
exit $LASTEXITCODE
