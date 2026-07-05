param(
  [int]$ServicePort = 4873,
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile
if (-not $env:VITE_INSPECTION_SERVICE_ORIGIN) {
  $env:VITE_INSPECTION_SERVICE_ORIGIN = "http://127.0.0.1:$ServicePort"
}

Push-Location $ClientDir
try {
  & npm.cmd run tauri -- dev
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
