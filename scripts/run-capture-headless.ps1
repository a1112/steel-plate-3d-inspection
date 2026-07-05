param(
  [int]$Port = 4317,
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Exe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"

if (-not (Test-Path $Exe)) {
  throw "Missing $Exe. Run scripts/build-capture-headless.ps1 first."
}

Push-Location (Split-Path $Exe)
try {
  & $Exe --port $Port
} finally {
  Pop-Location
}
