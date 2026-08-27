param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "release",
  [switch]$SkipFrontend,
  [switch]$AllowNetwork
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ManifestPath = Join-Path $RepoRoot "app\server-monitor\Cargo.toml"
$FrontendIndex = Join-Path $RepoRoot "target\client\frontend-dist\index.html"
$CargoTargetDirectory = Join-Path $RepoRoot "target\cargo"
$RunningMonitors = @(Get-Process -Name "steel-inspection-server-monitor" -ErrorAction SilentlyContinue)

if ($RunningMonitors.Count -gt 0) {
  $RunningIds = ($RunningMonitors | ForEach-Object { $_.Id }) -join ", "
  throw "server monitor is running (PID: $RunningIds); exit it from the tray before rebuilding"
}

Push-Location $RepoRoot
try {
  if (-not $SkipFrontend) {
    & npm.cmd --prefix (Join-Path $RepoRoot "app\client") run build
    if ($LASTEXITCODE -ne 0) {
      throw "server monitor frontend build failed with exit code $LASTEXITCODE"
    }
  }
  if (-not (Test-Path -LiteralPath $FrontendIndex -PathType Leaf)) {
    throw "server monitor frontend is missing: $FrontendIndex"
  }

  $CargoArgs = @(
    "build",
    "--manifest-path", $ManifestPath,
    "--target-dir", $CargoTargetDirectory,
    "--locked",
    "--features", "custom-protocol"
  )
  if ($Profile -eq "release") { $CargoArgs += "--release" }
  if (-not $AllowNetwork) { $CargoArgs += "--offline" }

  & cargo @CargoArgs
  if ($LASTEXITCODE -ne 0) {
    throw "server monitor Rust build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$ProfileDirectory = if ($Profile -eq "release") { "release" } else { "debug" }
$Executable = Join-Path $RepoRoot "target\cargo\$ProfileDirectory\steel-inspection-server-monitor.exe"
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "server monitor executable is missing after build: $Executable"
}

Write-Host "Independent server monitor built: $Executable"
