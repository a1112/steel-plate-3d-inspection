param(
  [ValidateSet("headless-cpp", "qt-terminal", "external-api", "simulated")]
  [string]$Provider = "headless-cpp",
  [string]$CaptureOrigin = "",
  [int]$Port = 4873,
  [switch]$NoCaptureAutostart,
  [string]$EnvFile = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$ConfigRoot = "",
  [switch]$ForceParameters
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

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

if ($NoCaptureAutostart) {
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
}

$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
$ServiceExe = Join-Path $RepoRoot "target\cargo\$Profile\steel-inspection-service.exe"
if (-not (Test-Path $ServiceExe -PathType Leaf)) {
  throw "Missing $ServiceExe. Run scripts/build-service.ps1 -Profile $Profile first."
}

& $ServiceExe
exit $LASTEXITCODE
