param(
  [int]$Port = 4881,
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "gray")]
  [string]$Mode = "api",
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

if (-not $env:TRIGGER_GATEWAY_PORT) {
  $env:TRIGGER_GATEWAY_PORT = [string]$Port
}
if (-not $env:TRIGGER_GATEWAY_HOST) {
  $env:TRIGGER_GATEWAY_HOST = $HostAddress
}
if (-not $env:INSPECTION_SERVICE_ORIGIN) {
  $env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
}
if (-not $env:TRIGGER_MODE) {
  $env:TRIGGER_MODE = $Mode
}

& cargo run --manifest-path (Join-Path $RepoRoot "app\service\Cargo.toml") --bin steel_trigger_gateway
exit $LASTEXITCODE
