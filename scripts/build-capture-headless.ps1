param(
  [string]$Configuration = "Release",
  [string]$GeneratorPlatform = "x64",
  [string]$BuildDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
  $BuildDir = Join-Path $RepoRoot "target\capture"
} elseif (-not [System.IO.Path]::IsPathRooted($BuildDir)) {
  $BuildDir = Join-Path $RepoRoot $BuildDir
}
$BuildDir = [System.IO.Path]::GetFullPath($BuildDir)

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

Write-Host "Headless capture service built at $(Join-Path $BuildDir "$Configuration\steel_capture_service.exe")"
