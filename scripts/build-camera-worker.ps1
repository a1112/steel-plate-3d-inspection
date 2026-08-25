param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "release",
  [switch]$Locked
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @(
  "build",
  "--manifest-path", (Join-Path $RepoRoot "app\camera-worker\Cargo.toml"),
  "--target-dir", (Join-Path $RepoRoot "target\camera-worker")
)
if ($Profile -eq "release") { $Args += "--release" }
if ($Locked) { $Args += "--locked" }
& cargo @Args
if ($LASTEXITCODE -ne 0) { throw "steel-capture-service build failed." }

Write-Host "Built real-camera host: target/camera-worker/$Profile/steel-capture-service.exe"
