param(
  [string]$Configuration = "Release",
  [string]$GeneratorPlatform = "x64"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildDir = Join-Path $RepoRoot "target\capture"

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

Invoke-Checked "cmake" @("-S", (Join-Path $RepoRoot "app\capture"), "-B", $BuildDir, "-A", $GeneratorPlatform)
Invoke-Checked "cmake" @("--build", $BuildDir, "--config", $Configuration)

Write-Host "Headless capture service built at target/capture/$Configuration/steel_capture_service.exe"
