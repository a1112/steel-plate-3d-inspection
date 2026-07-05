param(
  [ValidateSet("headless-cpp", "qt-terminal", "external-api", "simulated")]
  [string]$Provider = "headless-cpp",
  [string]$CaptureOrigin = "",
  [int]$Port = 4873,
  [switch]$NoCaptureAutostart,
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

if (-not $env:INSPECTION_SERVICE_PORT) {
  $env:INSPECTION_SERVICE_PORT = [string]$Port
}
if (-not $env:STEEL_CAPTURE_PROVIDER) {
  $env:STEEL_CAPTURE_PROVIDER = $Provider
}

if ($CaptureOrigin.Trim().Length -gt 0) {
  $env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin
}

if ($NoCaptureAutostart) {
  $env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
}

& cargo run --manifest-path (Join-Path $RepoRoot "app\service\Cargo.toml")
exit $LASTEXITCODE
