param(
  [int]$Port = 4881,
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$Mode = "api",
  [string]$EnvFile = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [switch]$ForceParameters
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile

if ($ForceParameters -or -not $env:TRIGGER_GATEWAY_PORT) {
  $env:TRIGGER_GATEWAY_PORT = [string]$Port
}
if ($ForceParameters -or -not $env:TRIGGER_GATEWAY_HOST) {
  $env:TRIGGER_GATEWAY_HOST = $HostAddress
}
if ($ForceParameters -or -not $env:INSPECTION_SERVICE_ORIGIN) {
  $env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
}
if ($ForceParameters -or -not $env:TRIGGER_MODE) {
  $env:TRIGGER_MODE = $Mode
}

$TriggerExe = Join-Path $RepoRoot "target\trigger\$Profile\steel-trigger-gateway.exe"
if (-not (Test-Path $TriggerExe -PathType Leaf)) {
  throw "Missing $TriggerExe. Run scripts/build-trigger-gateway.ps1 -Profile $Profile first."
}

& $TriggerExe
exit $LASTEXITCODE
