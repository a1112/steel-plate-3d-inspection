param(
  [int]$Port = 4881,
  [int]$TcpPort = 4882,
  [int]$UdpPort = 4883,
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$Mode = "api",
  [string]$EnvFile = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [ValidateSet("development", "acceptance", "production")]
  [string]$RuntimeProfile = "development",
  [string]$SourceAllowlist = "",
  [switch]$AllowModeMutation,
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
if ($ForceParameters -or -not $env:TRIGGER_TCP_PORT) {
  $env:TRIGGER_TCP_PORT = [string]$TcpPort
}
if ($ForceParameters -or -not $env:TRIGGER_UDP_PORT) {
  $env:TRIGGER_UDP_PORT = [string]$UdpPort
}
if ($ForceParameters -or -not $env:INSPECTION_SERVICE_ORIGIN) {
  $env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
}
if ($ForceParameters -or -not $env:TRIGGER_MODE) {
  $env:TRIGGER_MODE = $Mode
}
if ($ForceParameters -or -not $env:STEEL_RUNTIME_PROFILE) {
  $env:STEEL_RUNTIME_PROFILE = $RuntimeProfile
}
if ($ForceParameters -or -not $env:TRIGGER_SOURCE_ALLOWLIST) {
  $env:TRIGGER_SOURCE_ALLOWLIST = $SourceAllowlist
}
if ($AllowModeMutation) {
  $env:TRIGGER_ALLOW_MODE_MUTATION = "1"
}

$TriggerExe = Join-Path $RepoRoot "target\trigger\$Profile\steel-trigger-gateway.exe"
if (-not (Test-Path $TriggerExe -PathType Leaf)) {
  throw "Missing $TriggerExe. Run scripts/build-trigger-gateway.ps1 -Profile $Profile first."
}

& $TriggerExe
exit $LASTEXITCODE
