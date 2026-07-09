param(
  [string]$Configuration = "Release",
  [string]$GeneratorPlatform = "x64"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildDir = Join-Path $RepoRoot "target\algorithm-core"

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

Invoke-Checked "cmake" @("-S", (Join-Path $RepoRoot "app\algorithm-core"), "-B", $BuildDir, "-A", $GeneratorPlatform)
Invoke-Checked "cmake" @("--build", $BuildDir, "--config", $Configuration)

Write-Host "Bar surface algorithm core built at target/algorithm-core/$Configuration/steel_bar_surface_core.exe"
