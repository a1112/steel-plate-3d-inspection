param(
  [ValidateSet("headless-cpp", "external-api", "simulated")]
  [string]$Provider = "headless-cpp",
  [string]$CaptureOrigin = "",
  [string]$TriggerOrigin = "",
  [int]$Port = 4873,
  [switch]$NoCaptureAutostart,
  [string]$EnvFile = "",
  [string]$RuntimeProfile = "",
  [string]$AlgorithmMode = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$ConfigRoot = "",
  [string]$ArtifactAllowedRoots = "",
  [string]$AlgorithmRoot = "",
  [string]$AlgorithmConfigPath = "",
  [string]$AlgorithmCalibrationPath = "",
  [string]$AlgorithmCaptureRoot = "",
  [ValidateRange(10, 7200)]
  [int]$AlgorithmProcessTimeoutSec = 1800,
  [switch]$ForceParameters
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

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
if ($TriggerOrigin.Trim().Length -gt 0) {
  $env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
}

if ($NoCaptureAutostart) {
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
}

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
