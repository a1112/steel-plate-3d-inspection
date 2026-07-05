param(
  [switch]$Tauri
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"

Push-Location $ClientDir
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm build failed with exit code $LASTEXITCODE"
  }

  if ($Tauri) {
    & npm.cmd run build:standalone
    if ($LASTEXITCODE -ne 0) {
      throw "tauri build failed with exit code $LASTEXITCODE"
    }
  }
} finally {
  Pop-Location
}

Write-Host "Client frontend built at target/client/frontend-dist."
